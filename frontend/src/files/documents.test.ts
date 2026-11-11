import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readDocument } from "./documents";

const dir = new URL("../../../e2e/files/", import.meta.url);
const read = (n: string) => readDocument(n, new Uint8Array(readFileSync(new URL(n, dir))));

test("Word, OpenDocument text and old .doc", async () => {
  const d = (await read("report.docx"))!;
  assert.equal(d.format, "Word document");
  assert.match(d.text, /^# Mango Farm Report/m);
  assert.match(d.text, /1,250 kg of Alphonso/);
  assert.match(d.text, /^- Sorted by hand/m);
  assert.match(d.text, /\| Month \| Kg \|\n\| --- \| --- \|\n\| May \| 1250 \|/);
  assert.equal(d.images.length, 1);
  assert.match((await read("report.odt"))!.text, /Mango Farm Report[\s\S]*1,250 kg[\s\S]*\| May \| 1250 \|/);
  const doc = (await read("report.doc"))!;
  assert.equal(doc.format, "Word 97–2003 document");
  assert.match(doc.text, /1,250 kg of Alphonso mangoes/);
});

test("Excel and OpenDocument spreadsheets", async () => {
  const x = (await read("sales.xlsx"))!;
  assert.match(x.text, /## Sheet: Sales \(3 rows\)/);
  assert.match(x.text, /\| Item \| Qty \| Price \|/);
  assert.match(x.text, /\| Chai \| 3 \| 15 \| =B2\*C2 \|/);
  assert.match(x.text, /## Sheet: Notes[\s\S]*Shop opens at 7 am/);
  assert.match((await read("sales.ods"))!.text, /Chai[\s\S]*Samosa[\s\S]*Shop opens at 7 am/);
});

test("PowerPoint, EPUB, RTF, HTML, ZIP", async () => {
  const p = (await read("solar.pptx"))!;
  assert.match(p.text, /## Slide 1: Solar Energy\n\n- Clean and renewable\n\nSpeaker notes: Mention rooftop panels/);
  assert.match(p.text, /## Slide 2: Costs/);
  assert.equal(p.images.length, 1);
  const e = (await read("book.epub"))!;
  assert.match(e.text, /# Jungle Tales[\s\S]*tiger slept under the banyan tree/);
  assert.match((await read("letter.rtf"))!.text, /Dear Riya,\nYour order of 12 notebooks is ready\./);
  assert.match((await read("page.html"))!.text, /# Train times\n\nThe 7:15 to Pune is on platform 3\.\n\n- Fast\n- AC/);
  const z = (await read("code.zip"))!;
  assert.match(z.text, /- app\/main\.py/);
  assert.match(z.text, /--- app\/main\.py ---\nprint\("hello from the zip"\)/);
  assert.equal(z.images.length, 1);
  assert.equal(await readDocument("x.bin", Uint8Array.from([0, 1, 2, 3, 255, 0, 7])), null);
});
