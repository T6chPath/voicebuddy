import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFiles, projectName, webAppPage, zip } from "./project";

const ANSWER = `# Todo app

Here is the file tree:

\`\`\`
todo/
  index.html
\`\`\`

**\`todo/index.html\`**
\`\`\`html
<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>
<body><ul id="l"></ul><script src="app.js"></script></body></html>
\`\`\`

### todo/style.css
\`\`\`css
body { font: 16px sans-serif; }
\`\`\`

\`\`\`js title="todo/app.js"
document.getElementById("l").innerHTML = "<li>ok</li>";
\`\`\`

\`\`\`python
# file: todo/server.py
print("hi")
\`\`\`

\`\`\`bash
npm start
\`\`\`
`;

test("files named before, in or inside each code block", () => {
  const f = extractFiles(ANSWER);
  assert.deepEqual(f.map((x) => x.path), ["todo/index.html", "todo/style.css", "todo/app.js", "todo/server.py"]);
  assert.match(f[1].content, /font: 16px/);
  assert.equal(projectName(ANSWER, f), "todo");
});

test("web project becomes one page; zip is a valid archive", () => {
  const f = extractFiles(ANSWER);
  const page = webAppPage(f)!;
  assert.match(page, /<style>\nbody \{ font: 16px sans-serif; \}/);
  assert.match(page, /<script>\ndocument.getElementById/);
  assert.doesNotMatch(page, /src="app.js"|href="style.css"/);
  const z = zip(f, "todo");
  const dv = new DataView(z.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint32(z.length - 22, true), 0x06054b50);
  assert.equal(dv.getUint16(z.length - 22 + 10, true), 4);
  assert.match(new TextDecoder().decode(z), /todo\/server\.py/);
  assert.doesNotMatch(new TextDecoder().decode(z), /todo\/todo\//);
});
