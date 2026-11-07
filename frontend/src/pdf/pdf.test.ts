import assert from "node:assert/strict";
import { test } from "node:test";
import { documentMarkdown, pdfName, pdfTitle, wantsPdf } from "./pdf";

test("recognises requests for a PDF, in English and Hinglish", () => {
  for (const t of ["generate pdf of 30 quiz questions", "Make a PDF of a paragraph on pollution", "export this as PDF",
    "physics ke 20 questions ki pdf banao", "isko pdf me bana do", "can you give me notes on photosynthesis in pdf format", "PDF chahiye isski"]) assert.ok(wantsPdf(t), t);
  for (const t of ["what is a pdf file?", "summarise the attached pdf", "read this pdf and explain", "make a quiz of 10 questions", "how do I open pdf on android"]) assert.ok(!wantsPdf(t), t);
});

test("titles and file names", () => {
  assert.equal(pdfTitle("Here you go.\n\n# Physics Quiz — Class 9\n\n1. ...", "x"), "Physics Quiz — Class 9");
  assert.equal(pdfTitle("No heading here", "generate pdf of 30 quiz questions on physics"), "30 quiz questions physics");
  assert.equal(pdfName("Physics Quiz — Class 9"), "physics-quiz-class-9.pdf");
  assert.equal(pdfName("भौतिकी प्रश्नोत्तरी"), "भौतिकी-प्रश्नोत्तरी.pdf");
});

test("the file starts at the document, not the chat around it", () => {
  assert.equal(documentMarkdown("Sure! Here is your quiz.\n\n# Physics Quiz\n\n1. What is force?"), "1. What is force?");
  assert.equal(documentMarkdown("Just a paragraph."), "Just a paragraph.");
});
