"""邮件发送模块（smtplib 同步，邮件量小无需异步队列）。

降级策略：SQ_DEV=1 或未配置 SMTP_HOST 时，重置链接打印到日志，不阻塞流程。
密码找回功能在本地开发无 SMTP 也能测试——看后端日志拿 reset 链接。
"""

from __future__ import annotations

import logging
import os
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

logger = logging.getLogger(__name__)


def is_mail_configured() -> bool:
    """SMTP 是否已配置（SMTP_HOST 非空）。"""
    return bool(os.environ.get("SMTP_HOST", "").strip())


def _is_dev_mode() -> bool:
    return os.environ.get("SQ_DEV", "0") == "1"


def get_app_url() -> str:
    """reset 链接前缀。默认本地开发地址。"""
    return os.environ.get("APP_URL", "http://127.0.0.1:8001").strip().rstrip("/")


def send_email(to_addr: str, subject: str, html_body: str, text_body: str = "") -> bool:
    """发送邮件。成功返回 True，失败返回 False（不抛异常，调用方决定后续行为）。

    未配置 SMTP 或 SQ_DEV=1 时降级为日志打印，返回 True。
    """
    # 收件地址防注入：含换行可向 SMTP 会话注入命令（SMTP 命令/头注入）。
    # 在日志降级路径之前检查——畸形地址既不发送也不写入日志。
    if "\r" in to_addr or "\n" in to_addr:
        logger.error("拒绝发送邮件：收件地址含换行符（疑似注入）")
        return False

    host = os.environ.get("SMTP_HOST", "").strip()
    if not host or _is_dev_mode():
        logger.info(
            "[DEV/未配置SMTP] 邮件未发送 -> %s | 主题: %s | %s",
            to_addr, subject, text_body or html_body,
        )
        return True

    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "")
    from_addr = os.environ.get("EMAIL_FROM", user or "noreply@smart-quotation.local").strip()
    from_name = os.environ.get("EMAIL_FROM_NAME", "智能询价").strip()
    use_tls = os.environ.get("SMTP_USE_TLS", "true").strip().lower()

    msg = MIMEMultipart("alternative")
    msg["From"] = f"{from_name} <{from_addr}>" if from_name else from_addr
    msg["To"] = to_addr
    msg["Subject"] = subject
    if text_body:
        msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        if use_tls == "ssl":
            with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context(), timeout=15) as s:
                if user:
                    s.login(user, password)
                s.sendmail(from_addr, [to_addr], msg.as_string())
        else:
            with smtplib.SMTP(host, port, timeout=15) as s:
                if use_tls in ("true", "starttls"):
                    s.starttls(context=ssl.create_default_context())
                if user:
                    s.login(user, password)
                s.sendmail(from_addr, [to_addr], msg.as_string())
        logger.info("邮件已发送: to=%s subject=%s", to_addr, subject)
        return True
    except Exception as exc:  # noqa: BLE001 邮件失败不应阻断流程
        logger.error("邮件发送失败: to=%s err=%s", to_addr, exc)
        return False


def send_password_reset_email(to_addr: str, reset_url: str) -> bool:
    """发送密码重置邮件。"""
    subject = "重置您的密码 - 智能询价"
    text = f"您正在重置密码，请在 30 分钟内点击链接完成：\n{reset_url}\n\n如非本人操作请忽略此邮件。"
    html = (
        f"<div style='font-family:sans-serif;max-width:480px;margin:0 auto'>"
        f"<h3>重置您的密码</h3>"
        f"<p>请在 30 分钟内点击下方链接设置新密码：</p>"
        f"<p><a href='{reset_url}' style='display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:4px'>重置密码</a></p>"
        f"<p style='color:#666;font-size:12px'>如非本人操作请忽略此邮件。链接 30 分钟后失效。</p>"
        f"<p style='color:#999;font-size:12px;word-break:break-all'>如按钮无法点击，请复制此链接：{reset_url}</p>"
        f"</div>"
    )
    return send_email(to_addr, subject, html, text)
