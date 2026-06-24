from __future__ import annotations

import ast
import math
import operator
import re
from typing import Any


class FormulaEvaluator(ast.NodeVisitor):
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
            raise ValueError("formula operator is not allowed")
        return op(self.visit(node.left), self.visit(node.right))

    def visit_UnaryOp(self, node: ast.UnaryOp) -> float:
        op = self.operators.get(type(node.op))
        if not op:
            raise ValueError("formula operator is not allowed")
        return op(self.visit(node.operand))

    def visit_Call(self, node: ast.Call) -> float:
        if not isinstance(node.func, ast.Name) or node.func.id not in self.functions:
            raise ValueError("formula function is not allowed")
        args = [self.visit(arg) for arg in node.args]
        return float(self.functions[node.func.id](*args))

    def generic_visit(self, node: ast.AST) -> float:
        raise ValueError(f"formula node is not allowed: {type(node).__name__}")


class QuotationEngine:
    def __init__(self, store):
        self.store = store

    def quote(self, company_id: str, query: str) -> list[dict[str, Any]]:
        config = self.store.get_active_config(company_id)
        rows = self.store.search_items(company_id, query, self.searchable_fields(config))
        return [self.quote_row(row, config) for row in rows]

    def searchable_fields(self, config: dict[str, Any]) -> list[str]:
        return [field["key"] for field in config.get("fields", []) if field.get("searchable")]

    def quote_row(self, row: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
        fields = dict(row.get("fields") or {})
        decision = self.apply_rules(config.get("rules") or [], {"fields": fields})
        discount = decision.get("discount_percent", 55)
        variables = {**fields, "discount_percent": discount}
        price = self.calculate_price(
            (config.get("pricing") or {}).get("default_formula", "face_price * discount_percent / 100"),
            variables,
            (config.get("pricing") or {}).get("rounding") or {},
            int((config.get("pricing") or {}).get("decimal_places", 1)),
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
        value = self.evaluate_formula(formula, variables)
        if rounding.get("mode") == "ceil":
            factor = 10 ** max(decimals, 0)
            value = math.ceil(value * factor) / factor
            integer_above = float(rounding.get("integer_above", 0) or 0)
            if self.to_number(variables.get("face_price")) > integer_above:
                value = float(math.ceil(value))
                return str(int(value))
        return f"{value:.{max(decimals, 0)}f}"

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

        # 1. 必须有至少一条默认规则
        if not any(r.get("default") for r in rules):
            errors.append("缺少默认规则（default=true），报价时无兜底折扣")

        # 2. 规则条件字段必须存在
        for rule in rules:
            if rule.get("default"):
                continue
            for cond in (rule.get("when") or {}).get("all", []):
                field = cond.get("field")
                if field and field not in field_keys:
                    errors.append(f"规则 '{rule.get('id')}' 的条件字段 '{field}' 未在字段配置中定义")

        # 3. 动作类型必须合法
        allowed_actions = {"set_discount", "set_field", "set_formula", "stop"}
        for rule in rules:
            for action in rule.get("actions") or []:
                if action.get("type") not in allowed_actions:
                    errors.append(f"规则 '{rule.get('id')}' 包含非法动作类型：{action.get('type')}")

        # 4. 公式必须通过安全解析
        formula = (config.get("pricing") or {}).get("default_formula", "")
        if formula:
            try:
                self.evaluate_formula(formula, {"face_price": 100, "discount_percent": 55})
            except Exception as exc:
                errors.append(f"默认公式无法解析：{exc}")

        # 5. 复制模板引用的字段必须存在
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

    # ─── Customer-facing pricing (brand-based + profit + tax) ────────

    def quote_customer(self, customer: dict[str, Any], company_id: str, query: str) -> dict[str, Any]:
        """客户报价入口：基于品牌配置规则定价 + 利润 + 税务。

        - 公司账号(company)：使用 config rules 的品牌折扣 → base_price → +利润 → +税，脱敏面价/折扣
        - 管理员(admin)：返回完整数据（含面价、折扣率、报价），不计算利润/税
        """
        config = self.store.get_active_config(company_id)
        searchable = self.searchable_fields(config)
        rows = self.store.search_items(company_id, query, searchable)
        override_map = self.store.get_price_override_map(customer["id"])
        pricing = config.get("pricing") or {}
        rounding = pricing.get("rounding") or {}
        decimals = int(pricing.get("decimal_places", 1))
        is_admin = (customer.get("account_type") or "company") == "admin"

        results = []
        for row in rows:
            # 先用品牌配置规则计算（engine.quote_row 的核心逻辑）
            quoted = self.quote_row(row, config)
            results.append(self._build_customer_result(
                customer, quoted, row, config, override_map, rounding, decimals, is_admin
            ))

        return {
            "company_id": company_id,
            "config_revision": config["revision"],
            "account_type": customer.get("account_type") or "company",
            "results": results,
        }

    def _build_customer_result(
        self,
        customer: dict[str, Any],
        quoted: dict[str, Any],
        row: dict[str, Any],
        config: dict[str, Any],
        override_map: dict[str, float],
        rounding: dict[str, Any],
        decimals: int,
        is_admin: bool,
    ) -> dict[str, Any]:
        """构建单行报价结果。

        品牌折扣定价流程:
          1. engine.quote_row → quote_price = face_price × brand_discount% (如 100×32.5%=32.5)
          2. 若有价格覆盖 → base_price = override_price
          3. base_price = quote_price (品牌折扣价)
          4. final = base × (1+profit%) 或 base+amount 或 base
          5. tax = final × tax_rate, incl_tax = final + tax
        """
        fields = dict(quoted.get("fields") or {})
        item_key = quoted.get("item_key", "")
        discount_percent = float(quoted.get("discount_percent") or 0)
        list_price = self.to_number(fields.get("face_price"))

        # 品牌折扣价 = engine 计算的 quote_price
        brand_price = self.to_number(fields.get("quote_price"))

        # 价格覆盖优先
        if item_key in override_map:
            base_price = override_map[item_key]
        else:
            base_price = brand_price

        # 管理员：返回完整数据，不计算利润/税
        if is_admin:
            return {
                "item_key": item_key,
                "fields": fields,
                "face_price": self._format_price(list_price, decimals),
                "discount_percent": discount_percent,
                "quote_price": self._format_price(brand_price, decimals),
                "matched_rule": quoted.get("matched_rule"),
                "copy_text": quoted.get("copy_text", ""),
                "is_admin": True,
            }

        # 公司账号：计算利润 + 税务，脱敏
        profit_mode = customer.get("profit_mode") or "none"
        profit_value = float(customer.get("profit_value") or 0)
        if profit_mode == "percent":
            final_quote = base_price * (1 + profit_value / 100)
        elif profit_mode == "amount":
            final_quote = base_price + profit_value
        else:
            final_quote = base_price

        final_quote = self._apply_rounding(final_quote, rounding, decimals)
        base_price_r = self._apply_rounding(base_price, rounding, decimals)

        tax_rate = float(customer.get("tax_rate") or 0)
        tax_amount = self._apply_rounding(final_quote * tax_rate, rounding, decimals)
        incl_tax = self._apply_rounding(final_quote + tax_amount, rounding, decimals)

        # 脱敏：剔除 face_price 和 quote_price
        sanitized_fields = {k: v for k, v in fields.items()
                            if k not in ("face_price", "quote_price")}

        return {
            "item_key": item_key,
            "fields": sanitized_fields,
            "base_price": self._format_price(base_price_r, decimals),
            "final_quote": self._format_price(final_quote, decimals),
            "tax_rate": tax_rate,
            "tax_amount": self._format_price(tax_amount, decimals),
            "price_incl_tax": self._format_price(incl_tax, decimals),
            "profit_mode": profit_mode,
            "profit_value": profit_value,
            "is_admin": False,
        }

    def _apply_rounding(self, value: float, rounding: dict[str, Any], decimals: int) -> float:
        """应用取整规则（与 calculate_price 一致）。

        先 round 到 6 位消除浮点误差（如 55.00000001 → 55.0），再 ceil。
        """
        # 消除浮点误差：先 round 到 6 位小数
        value = round(value, 6)
        if rounding.get("mode") == "ceil":
            factor = 10 ** max(decimals, 0)
            value = math.ceil(value * factor) / factor
        return value

    def _format_price(self, value: float, decimals: int) -> str:
        """格式化价格字符串。"""
        return f"{value:.{max(decimals, 0)}f}"
