Evaluation and iteration
Build evaluations first
Create evaluations BEFORE writing extensive documentation. This ensures your Skill solves real problems rather than documenting imagined ones.

Evaluation-driven development:

Identify gaps: Run Claude on representative tasks without a Skill. Document specific failures or missing context
Create evaluations: Build three scenarios that test these gaps
Establish baseline: Measure Claude's performance without the Skill
Write minimal instructions: Create just enough content to address the gaps and pass evaluations
Iterate: Execute evaluations, compare against baseline, and refine
This approach ensures you're solving actual problems rather than anticipating requirements that may never materialize.

Evaluation structure:

```
{
  "skills": ["pdf-processing"],
  "query": "Extract all text from this PDF file and save it to output.txt",
  "files": ["test-files/document.pdf"],
  "expected_behavior": [
    "Successfully reads the PDF file using an appropriate PDF processing library or command-line tool",
    "Extracts text content from all pages in the document without missing any pages",
    "Saves the extracted text to a file named output.txt in a clear, readable format"
  ]
}
``````
This example demonstrates a data-driven evaluation with a simple testing rubric. We do not currently provide a built-in way to run these evaluations. Users can create their own evaluation system. Evaluations are your source of truth for measuring Skill effectiveness.
