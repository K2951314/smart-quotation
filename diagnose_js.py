import pathlib
import js2py

path = pathlib.Path('admin/app.js')
text = path.read_text(encoding='utf-8')
try:
    js2py.parse(text)
    print('parse ok')
except Exception as e:
    print(type(e).__name__)
    print(e)