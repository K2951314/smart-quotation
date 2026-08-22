from __future__ import annotations

import ast
import logging
import math
import operator
import re
from typing import Any

logger = logging.getLogger(__name__)


class FormulaEvaluator(ast.NodeVisitor):
    """安全公式求值器：严格白名单模式。

    只允许以下 AST 节点：
    - Expression, Constant, Name, BinOp, UnaryOp, Call
    只允许以下运算符：
    - +, -, *, /, 一元负号
    只允许以下函数：
    - ceil, floor, round, min, max, abs

    任何其他节点类型（属性访问、下标、比较、布尔运算等）一律拒绝。
    """

    ALLOWED_NODES = frozenset({
        "Expression", "Constant", "Name", "BinOp", "UnaryOp", "Call", "Load",
    })
    operators = {
        ast.Add: operator.add,
        ast.Sub: operator.sub,
        ast.Mult: operator.mul,
        ast.Div: operator.truediv,
        ast.USub: operator.neg,
    }
    functions = {
        "ceil": math.ceil,
        "floor": math.floor,
        "round": round,
        "min": min,
        "max": max,
        "abs": abs,
    }

    def __init__(self, variables: dict[str, Any]):
        self.variables = variables

    def visit_Expression(self, node: ast.Expression) -> float:
        return self.visit(node.body)

    def visit_Constant(self, node: ast.Constant) -> float:
        if isinstance(node.value, (int, float)):
            return float(node.value)
        raise ValueError("formula only supports numeric constants")

    def visit_Name(self, node: ast.Name) -> float:
        value = self.variables.get(node.id, 0)
        try:
            return float(value or 0)
        except (TypeError, ValueError):
            return 0.0

    def visit_BinOp(self, node: ast.BinOp) -> float:
        op = self.operators.get(type(node.op))
        if not op:
            raise ValueError(f"formula operator not allowed: {type(node.op).__name__}")
        left = self.visit(node.left)
        right = self.visit(node.right)
        if isinstance(node.op, ast.Div) and right == 0:
            # 除数为 0（如 discount_percent=0 或引用缺失变量）→ 安全兜底 0，避免 ZeroDivisionError
            return 0.0
        return op(left, right)

    def visit_UnaryOp(self, node: ast.UnaryOp) -> float:
        op = self.operators.get(type(node.op))
        if not op:
            raise ValueError(f"formula unary operator not allowed: {type(node.op).__name__}")
        return op(self.visit(node.operand))

    def visit_Call(self, node: ast.Call) -> float:
        if not isinstance(node.func, ast.Name) or node.func.id not in self.functions:
            raise ValueError("formula function is not allowed")
        # 拒绝关键字参数（防止构造特殊调用）
        if node.keywords:
            raise ValueError("formula function calls cannot use keyword arguments")
        args = [self.visit(arg) for arg in node.args]
        return float(self.functions[node.func.id](*args))

    def visit_Load(self, node: ast.Load) -> None:
        """Load context node — no-op, just allow it."""
        return None

    def generic_visit(self, node: ast.AST) -> float:
        node_name = type(node).__name__
        raise ValueError(f"formula node not allowed: {node_name}")


class QuotationEngine:
    def __init__(self, store):
        self.store = store

    def quote(self, query: str, company_id: str = None) -> list[dict[str, Any]]:
        config = self.store.get_active_config(company_id=company_id) if company_id else self.store.get_active_config()
        rows = self.store.search_items(query, self.searchable_fields(config), company_id=company_id) if company_id else self.store.search_items(query, self.searchable_fields(config))
        return [self.quote_row(row, config) for row in rows]

    def searchable_fields(self, config: dict[str, Any]) -> list[str]:
        return [field["key"] for field in config.get("fields", []) if field.get("searchable")]

    def quote_row(self, row: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
        fields = dict(row.get("fields") or {})
        decision = self.apply_rules(config.get("rules") or [], {"fields": fields})
        discount = decision.get("discount_percent", 55)
        variables = {**fields, "discount_percent": discount}
        pricing = config.get("pricing") or {}
        price = self.calculate_price(
            pricing.get("default_formula", "face_price * discount_percent / 100"),
            variables,
            self._resolve_rounding(pricing),
            int(pricing.get("decimal_places", 1)),
        )
        fields["quote_price"] = price
        return {
            "item_key": row.get("item_key"),
            "fields": fields,
            "matched_rule": decision.get("rule_id"),
            "discount_percent": discount,
            "copy_text": self.render_copy_text(fields, config),
        }

    def apply_rules(self, rules: list[dict[str, Any]], ctx: dict[str, Any]) -> dict[str, Any]:
        default_rule = None
        for rule in sorted(rules, key=lambda item: int(item.get("priority") or 0)):
            if rule.get("default"):
                default_rule = rule
                continue
            if self.when_matches(rule.get("when") or {}, ctx.get("fields") or {}):
                return self.apply_actions(rule, ctx)
        return self.apply_actions(default_rule or {}, ctx)

    def apply_actions(self, rule: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
        decision: dict[str, Any] = {"rule_id": rule.get("id")}
        fields = ctx.get("fields") or {}
        for action in rule.get("actions") or []:
            action_type = action.get("type")
            if action_type == "set_discount":
                decision["discount_percent"] = float(action.get("percent", 55))
            elif action_type == "set_field":
                fields[str(action.get("field"))] = action.get("value")
            elif action_type == "set_formula":
                fields[str(action.get("field"))] = self.evaluate_formula(str(action.get("formula") or "0"), fields)
            elif action_type == "stop":
                break
        if "discount_percent" not in decision:
            decision["discount_percent"] = 55
        return decision

    def when_matches(self, when: dict[str, Any], fields: dict[str, Any]) -> bool:
        if not when:
            return False
        if "all" in when:
            return all(self.when_matches(item or {}, fields) for item in when.get("all") or [])
        if "any" in when:
            return any(self.when_matches(item or {}, fields) for item in when.get("any") or [])
        if "not" in when:
            return not self.when_matches(when.get("not") or {}, fields)
        return self.condition_matches(when, fields)

    def condition_matches(self, condition: dict[str, Any], fields: dict[str, Any]) -> bool:
        field_value = fields.get(condition.get("field"))
        op = condition.get("op")
        expected = condition.get("value")
        text = "" if field_value is None else str(field_value)
        if op == "equals":
            return text == str(expected)
        if op == "contains":
            return str(expected).replace(" ", "").upper() in text.replace(" ", "").upper()
        if op == "regex":
            return re.search(str(expected), text, re.IGNORECASE) is not None
        if op == "in":
            return field_value in (expected or [])
        left = self.to_number(field_value)
        if op == "gt":
            return left > self.to_number(expected)
        if op == "gte":
            return left >= self.to_number(expected)
        if op == "lt":
            return left < self.to_number(expected)
        if op == "lte":
            return left <= self.to_number(expected)
        if op == "between":
            low, high = list(expected or [0, 0])[:2]
            return self.to_number(low) <= left <= self.to_number(high)
        return False

    def calculate_price(self, formula: str, variables: dict[str, Any], rounding: dict[str, Any], decimals: int = 1) -> str:
        try:
            value = self.evaluate_formula(formula, variables)
        except (ArithmeticError, ValueError) as exc:
            # 运行时求值失败（除零/数值异常）→ 安全兜底 0，避免 quote 路径 500
            logger.warning("报价公式求值失败，兜底为 0: formula=%s, error=%s", formula, exc)
            return f"{0:.{max(decimals, 0)}f}"
        decimals = max(decimals, 0)
        mode = str(rounding.get("mode") or "ceil")
        rounded_value = self.round_price(value, decimals, mode)
        # 缺失时 fallback 100（与前端 export-utils.js / config-core.js 一致），
        # 避免阈值被当 0 导致所有报价被取整为整数。
        integer_above = rounding.get("integer_above")
        if integer_above is None or str(integer_above).strip() == "":
            integer_above = 100
        integer_above = float(integer_above)
        if rounded_value > integer_above:
            return str(int(self.round_price(value, 0, mode)))
        return f"{rounded_value:.{decimals}f}"

    @staticmethod
    def round_price(value: float, decimals: int, mode: str) -> float:
        factor = 10 ** max(decimals, 0)
        scaled = value * factor
        if mode == "floor":
            return math.floor(scaled + 1e-9) / factor
        if mode == "round":
            return math.floor(scaled + 0.5 + 1e-9) / factor
        return math.ceil(scaled - 1e-9) / factor

    @staticmethod
    def _resolve_rounding(pricing: dict[str, Any]) -> dict[str, Any]:
        """解析取整配置：兼容嵌套 rounding.{mode,integer_above} 与旧扁平
        pricing.rounding_threshold，缺失时 fallback mode=ceil / integer_above=100。
        与 config-core.js normalizeConfig / export-utils.js _desensitizeFields 保持一致，
        防止旧扁平配置让阈值变 0 → 所有报价被取整为整数。"""
        rounding = dict(pricing.get("rounding") or {})
        if not rounding.get("mode"):
            rounding["mode"] = "ceil"
        ia = rounding.get("integer_above")
        if ia is None or str(ia).strip() == "":
            rt = pricing.get("rounding_threshold")
            if rt is not None and str(rt).strip() != "":
                rounding["integer_above"] = rt
        ia = rounding.get("integer_above")
        if ia is None or str(ia).strip() == "":
            rounding["integer_above"] = 100
        return rounding

    def evaluate_formula(self, formula: str, variables: dict[str, Any]) -> float:
        tree = ast.parse(formula, mode="eval")
        return float(FormulaEvaluator(variables).visit(tree))

    def render_copy_text(self, fields: dict[str, Any], config: dict[str, Any]) -> str:
        main: list[str] = []
        detail: list[str] = []
        for column in (config.get("copy") or {}).get("columns") or []:
            if not column.get("default"):
                continue
            value = fields.get(column.get("field"))
            if value in (None, ""):
                continue
            text = f"{column.get('prefix', '')}{value}{column.get('suffix', '')}"
            if column.get("line") == "detail":
                detail.append(text)
            else:
                main.append(text)
        return "\n".join([" ".join(main), *detail]).strip()

    def validate_config(self, config: dict[str, Any]) -> list[str]:
        """校验配置合法性，返回错误列表（空列表 = 通过）"""
        errors: list[str] = []
        fields = config.get("fields") or []
        rules = config.get("rules") or []
        field_keys = {f["key"] for f in fields if f.get("key")}

        # 基础检查（委托 config 模块）
        try:
            from .config import validate_config as _base_validate
            _base_validate(config)
        except ValueError as exc:
            errors.append(str(exc))

        # 至少一条默认规则
        if not any(r.get("default") for r in rules):
            errors.append("缺少默认规则（default=true），报价时无兜底折扣")

        # 条件字段引用检查
        for rule in rules:
            if rule.get("default"):
                continue
            for cond in (rule.get("when") or {}).get("all", []):
                field = cond.get("field")
                if field and field not in field_keys:
                    errors.append(f"规则 '{rule.get('id')}' 的条件字段 '{field}' 未在字段配置中定义")

        # 公式必须通过安全解析
        formula = (config.get("pricing") or {}).get("default_formula", "")
        if formula:
            try:
                self.evaluate_formula(formula, {"face_price": 100, "discount_percent": 55})
            except Exception as exc:
                errors.append(f"默认公式无法解析：{exc}")

        # 复制模板引用的字段必须存在
        for col in (config.get("copy") or {}).get("columns") or []:
            field = col.get("field")
            if field and field not in field_keys and field != "quote_price":
                errors.append(f"复制模板字段 '{field}' 未在字段配置中定义")

        return errors

    def to_number(self, value: Any) -> float:
        try:
            return float(value or 0)
        except (TypeError, ValueError):
            return 0.0

