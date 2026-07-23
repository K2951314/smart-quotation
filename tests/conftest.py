import os

# 裸跑 pytest 时按本地开发处理：factory.py 的生产校验要求
# 生产环境必须设置 ALLOW_ORIGINS，SQ_DEV=1 可跳过（仅测试进程内生效）。
os.environ.setdefault("SQ_DEV", "1")
