# Todo app

Here is the file tree:

```
todo/
  index.html
```

**`todo/index.html`**
```html
<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>
<body><ul id="l"></ul><script src="app.js"></script></body></html>
```

### todo/style.css
```css
body { font: 16px sans-serif; }
```

```js title="todo/app.js"
document.getElementById("l").innerHTML = "<li>ok</li>";
```

```python
# file: todo/server.py
print("hi")
```

```bash
npm start
```
