require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const axios = require('axios');
const mammoth = require('mammoth');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Serve files from project root (so index.html at repository root is served)
app.use(express.static(path.join(__dirname)));

// Fallback for root to serve index.html if present
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// In-memory storage for documents
const documents = new Map();
let documentCounter = 0;

// Extract text from PDF
async function extractPdfText(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);
  return data.text;
}

// Extract text from TXT
async function extractTxtText(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

// Extract text from DOCX
async function extractDocxText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

// Normalize text to reduce parser differences (PDF vs DOCX)
function normalizeText(text) {
  if (!text) return '';
  let t = String(text);
  // Normalize line endings
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Replace non-breaking spaces and tabs
  t = t.replace(/\u00A0/g, ' ').replace(/\t/g, ' ');
  // Collapse multiple spaces (but preserve newlines)
  t = t.split('\n').map(line => line.replace(/ {2,}/g, ' ').trimEnd()).join('\n');
  // Preserve blank lines (do not collapse) and keep original leading/trailing newlines
  return t;
}

// Upload endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const fileName = req.body.name || file.originalname;
    
    let content = '';
    const nameLower = (file.originalname || '').toLowerCase();
    if (file.mimetype === 'application/pdf' || nameLower.endsWith('.pdf')) {
      content = await extractPdfText(file.path);
    } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || nameLower.endsWith('.docx')) {
      try {
        // Extract raw text (preserves newlines) and also get HTML for richer rendering
        const rawResult = await mammoth.extractRawText({ path: file.path });
        const resultHtml = await mammoth.convertToHtml({ path: file.path });
        const html = resultHtml.value || '';
        // Prefer cleaned HTML-to-text to avoid token-joining issues seen in some extractions
        function serverHtmlToText(h) {
          if (!h) return '';
          // replace common block tags with newlines
          let s = String(h).replace(/<\s*(br|p|div|li|h[1-6]|tr|td)[^>]*>/gi, '\n');
          // remove all remaining tags
          s = s.replace(/<[^>]+>/g, '');
          // decode a few common HTML entities
          s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
          // normalize whitespace and newlines but preserve blank lines
          s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          s = s.split('\n').map(l => l.replace(/\s+/g, ' ').replace(/\s+$/,'')).join('\n');
          // split joined camel/capitalized runs (ClinicPatient -> Clinic Patient)
          s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
          return s;
        }
        content = serverHtmlToText(html) || ((rawResult && rawResult.value) ? rawResult.value : '');
        // attach html for richer rendering
        req._extractedHtml = html;
      } catch (e) {
        content = await extractTxtText(file.path);
      }
    } else {
      // default: attempt to read as utf-8 text
      try {
        content = await extractTxtText(file.path);
      } catch (e) {
        content = '';
      }
    }
    
    const docId = `doc_${documentCounter++}`;
    const docObj = {
      id: docId,
      name: fileName,
      content: content,
      createdAt: new Date(),
      type: file.mimetype
    };
    if (req._extractedHtml) docObj.html = req._extractedHtml;
    documents.set(docId, docObj);
    
    fs.unlinkSync(file.path);
    
    res.json({
      id: docId,
      name: fileName,
      preview: content.substring(0, 200)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all documents
app.get('/api/documents', (req, res) => {
  const docs = Array.from(documents.values()).map(doc => ({
    id: doc.id,
    name: doc.name,
    preview: (doc.content && typeof doc.content === 'string') ? doc.content.substring(0, 150) : String(doc.content || '').substring(0,150)
  }));
  res.json(docs);
});

// Get document content
app.get('/api/documents/:id', (req, res) => {
  const doc = documents.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json(doc);
});

// Normalize any stored docs that have HTML (re-run server-side HTML -> text conversion)
app.post('/api/normalize-docs', (req, res) => {
  let updated = 0;
  for (const [id, doc] of documents.entries()) {
    if (doc.html) {
      // reuse server-side conversion logic
      const html = doc.html || '';
      let s = String(html).replace(/<\s*(br|p|div|li|h[1-6]|tr|td)[^>]*>/gi, '\n');
      s = s.replace(/<[^>]+>/g, '');
      s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      s = s.split('\n').map(l => l.replace(/\s+/g, ' ').replace(/\s+$/,'')).join('\n');
      s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
      doc.content = s;
      documents.set(id, doc);
      updated++;
    }
  }
  res.json({ updated });
});

// Update document
app.put('/api/documents/:id', (req, res) => {
  const doc = documents.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  
  doc.content = req.body.content;
  res.json(doc);
});

// Compare documents
app.post('/api/compare', (req, res) => {
  const { baseId, compareId, baseContent, compareContent } = req.body;
  const baseDoc = documents.get(baseId);
  const compareDoc = documents.get(compareId);
  
  if (!baseDoc || !compareDoc) {
    return res.status(404).json({ error: 'One or both documents not found' });
  }
  
  const comparison = compareDocuments(
    typeof baseContent === 'string' ? baseContent : baseDoc.content,
    typeof compareContent === 'string' ? compareContent : compareDoc.content
  );
  res.json(comparison);
});

// Format analysis using OpenAI / OpenRouter: detect bold/italic/color/font changes
app.post('/api/format-analyze', async (req, res) => {
  const { baseHtml, compareHtml } = req.body || {};
  if (!baseHtml || !compareHtml) return res.status(400).json({ error: 'baseHtml and compareHtml required' });

  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'No OpenAI/OpenRouter API key configured in environment' });

  // Build prompt asking for strict JSON output
  const system = `You are a JSON-only assistant. Given two HTML documents (base and compare), identify words or short phrases where formatting differs. For each difference return an object with keys: "text" (the exact token or short phrase), "base" (object with boolean keys: bold, italic; and optional strings: color, fontFamily, fontSize), "compare" (same structure), and "changes" (array of strings among 'bold','italic','color','font'). Return a JSON object: {"changes": [ ... ]}. Do not provide any explanatory text.`;

  const user = `BASE_HTML_START\n${baseHtml}\nBASE_HTML_END\nCOMPARE_HTML_START\n${compareHtml}\nCOMPARE_HTML_END\n\nReturn the JSON object described above.`;

  try {
    // If GEMINI_API_KEY is present, prefer Google Generative API (Gemini)
    if (process.env.GEMINI_API_KEY) {
      const key = process.env.GEMINI_API_KEY;
      const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key)}`;
      const genPayload = {
        systemInstruction: {
          parts: [{ text: system }]
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: user }]
          }
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 800,
          responseMimeType: 'application/json'
        }
      };
      const r = await axios.post(genUrl, genPayload, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
      // Attempt to extract text from Gemini response
      const text = r.data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
      const jsonText = text.trim();
      let parsed;
      try { parsed = JSON.parse(jsonText); } catch (e) {
        return res.status(500).json({ error: 'Failed to parse Gemini response as JSON', response: text });
      }
      return res.json(parsed);
    }

    // Decide endpoint: OpenAI or OpenRouter
    const isOpenRouter = !!process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY;
    const url = isOpenRouter ? 'https://api.openrouter.ai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    };

    const payload = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0,
      max_tokens: 800
    };

    const r = await axios.post(url, payload, { headers, timeout: 20000 });
    const text = r.data?.choices?.[0]?.message?.content || r.data?.choices?.[0]?.text || '';

    // Attempt to extract JSON substring
    const m = text.match(/\{[\s\S]*\}/);
    const jsonText = m ? m[0] : text;
    let parsed;
    try { parsed = JSON.parse(jsonText); } catch (e) {
      return res.status(500).json({ error: 'Failed to parse AI response as JSON', response: text });
    }

    return res.json(parsed);
  } catch (error) {
    // Better error logging for debugging API auth issues
    console.error('format-analyze error', error?.toString() || error);
    if (error.response) {
      console.error('remote status:', error.response.status);
      console.error('remote data:', JSON.stringify(error.response.data));
    }
    return res.status(500).json({ error: error.message || String(error), details: error.response?.data });
  }
});

// Word-based diff algorithm
function compareDocuments(baseText, compareText) {
  baseText = normalizeText(baseText || '');
  compareText = normalizeText(compareText || '');

  const baseWords = baseText.split(/\s+/);
  const compareWords = compareText.split(/\s+/);
  
  const diff = longestCommonSubsequence(baseWords, compareWords);
  
  const baseDiff = generateDiff(baseWords, compareWords, 'base');
  const compareDiff = generateDiff(baseWords, compareWords, 'compare');
  
  return {
    base: {
      content: baseText,
      diff: baseDiff
    },
    compare: {
      content: compareText,
      diff: compareDiff
    },
    combined: generateCombinedView(baseDiff, compareDiff),
    // Line-by-line diff with line numbers
    lineDiffs: generateLineDiffs(baseText, compareText),
    stats: {
      baseWords: baseWords.length,
      compareWords: compareWords.length,
      addedWords: compareDiff.filter(w => w.type === 'added').length,
      removedWords: baseDiff.filter(w => w.type === 'removed').length,
      similarity: calculateSimilarity(baseWords, compareWords)
    }
  };
}

// Generate line-by-line diffs
function generateLineDiffs(baseText, compareText) {
  const baseLines = baseText.split(/\r?\n/);
  const compareLines = compareText.split(/\r?\n/);
  const m = baseLines.length;
  const n = compareLines.length;

  // build LCS DP table
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (baseLines[i - 1] === compareLines[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // backtrack matches
  const matches = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (baseLines[i - 1] === compareLines[j - 1]) {
      matches.unshift({ i: i - 1, j: j - 1 });
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) i--;
    else j--;
  }

  // build aligned rows using matches
  const rows = [];
  let ai = 0, bj = 0;
  for (let k = 0; k <= matches.length; k++) {
    const mi = matches[k]?.i ?? m;
    const mj = matches[k]?.j ?? n;

    // handle unmatched region before the match
    while (ai < mi || bj < mj) {
      if (ai < mi && bj < mj) {
        // both have content but not matching -> changed
        const b = baseLines[ai];
        const c = compareLines[bj];
        rows.push({ base: b, compare: c, status: 'changed', baseLineNumber: ai + 1, compareLineNumber: bj + 1 });
        ai++; bj++;
      } else if (ai < mi) {
        const b = baseLines[ai];
        rows.push({ base: b, compare: '', status: 'removed', baseLineNumber: ai + 1, compareLineNumber: null });
        ai++;
      } else {
        const c = compareLines[bj];
        rows.push({ base: '', compare: c, status: 'added', baseLineNumber: null, compareLineNumber: bj + 1 });
        bj++;
      }
    }

    // matched line (if not sentinel)
    if (k < matches.length) {
      rows.push({ base: baseLines[mi], compare: compareLines[mj], status: 'same', baseLineNumber: mi + 1, compareLineNumber: mj + 1 });
      ai = mi + 1;
      bj = mj + 1;
    }
  }

  // Add per-word diffs for changed rows
  const lines = rows.map((r, idx) => {
    let baseWordDiff = null;
    let compareWordDiff = null;
    if (r.status === 'changed') {
      const bWords = r.base.trim().length ? r.base.split(/\s+/) : [];
      const cWords = r.compare.trim().length ? r.compare.split(/\s+/) : [];
      baseWordDiff = generateDiff(bWords, cWords, 'base');
      compareWordDiff = generateDiff(bWords, cWords, 'compare');
    }
    return {
      line: idx + 1,
      base: r.base,
      compare: r.compare,
      status: r.status,
      baseLineNumber: r.baseLineNumber || null,
      compareLineNumber: r.compareLineNumber || null,
      baseWordDiff,
      compareWordDiff
    };
  });

  // Group each changed/added/removed row into its own change group
  // (prevents large merged groups when many changed lines are adjacent)
  const changeGroups = [];
  lines.forEach((ln) => {
    if (ln.status === 'same') return;

    const g = {
      type: ln.status === 'added' ? 'added' : ln.status === 'removed' ? 'removed' : 'replaced',
      startLine: ln.line,
      endLine: ln.line,
      baseSnippet: [],
      compareSnippet: [],
      added: 0,
      removed: 0
    };

    if (ln.status === 'added') {
      g.added = 1;
      g.compareSnippet.push(ln.compare);
    } else if (ln.status === 'removed') {
      g.removed = 1;
      g.baseSnippet.push(ln.base);
    } else {
      g.baseSnippet.push(ln.base);
      g.compareSnippet.push(ln.compare);
    }

    changeGroups.push(g);
  });

  // For each change group, compute finer-grained word segments (like Draftable)
  function wordSegments(baseLinesArr, compareLinesArr) {
    const baseText = (baseLinesArr || []).join(' ');
    const compareText = (compareLinesArr || []).join(' ');

    // Better tokenizer: dates, words/numbers/dots/dashes/underscores, or any single non-space non-alnum char
    const tokenize = (text) => {
      return (
        text.match(/\d{2}\/\d{2}\/\d{4}|[A-Za-z0-9_\.\-]+|[^\sA-Za-z0-9]/g) || []
      );
    };

    const baseTokens = tokenize(baseText);
    const compareTokens = tokenize(compareText);

    const m = baseTokens.length;
    const n = compareTokens.length;

    // LCS DP table
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (baseTokens[i - 1] === compareTokens[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
        else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }

    // Backtrack edits
    let i = m, j = n;
    const edits = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && baseTokens[i - 1] === compareTokens[j - 1]) {
        edits.unshift({ type: 'same', token: baseTokens[i - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        edits.unshift({ type: 'added', token: compareTokens[j - 1] });
        j--;
      } else {
        edits.unshift({ type: 'removed', token: baseTokens[i - 1] });
        i--;
      }
    }

    // helper to compact spaces around punctuation
    function compactSpaces(str) {
      return str
        .replace(/\s+([.,:;!?])/g, '$1')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Convert edits into Draftable-style replacements
    const segments = [];
    let removed = [];
    let added = [];

    function flush() {
      if (!removed.length && !added.length) return;
      segments.push({
        type: 'replaced',
        base: compactSpaces(removed.join(' ')),
        compare: compactSpaces(added.join(' '))
      });
      removed = [];
      added = [];
    }

    edits.forEach(edit => {
      if (edit.type === 'same') { flush(); return; }
      if (edit.type === 'removed') removed.push(edit.token);
      if (edit.type === 'added') added.push(edit.token);
    });

    flush();

    // Remove junk replacements (identical or punctuation-only)
    return segments.filter(seg => {
      const b = seg.base.replace(/\s+/g, ' ').trim();
      const c = seg.compare.replace(/\s+/g, ' ').trim();
      if (b === c) return false;
      if (/^[^A-Za-z0-9]+$/.test(b) && /^[^A-Za-z0-9]+$/.test(c)) return false;
      return true;
    });
  }

  changeGroups.forEach(g => {
    try {
      g.changes = wordSegments(g.baseSnippet || [], g.compareSnippet || []);
    } catch (e) {
      g.changes = [];
    }
  });

  return { lines, changeGroups };
}

// Simple diff algorithm
function generateDiff(baseWords, compareWords, type) {
  const result = [];
  let i = 0, j = 0;
  
  while (i < baseWords.length || j < compareWords.length) {
    if (i >= baseWords.length) {
      result.push({ word: compareWords[j], type: type === 'base' ? 'none' : 'added' });
      j++;
    } else if (j >= compareWords.length) {
      result.push({ word: baseWords[i], type: type === 'base' ? 'removed' : 'none' });
      i++;
    } else if (baseWords[i] === compareWords[j]) {
      result.push({ word: baseWords[i], type: 'same' });
      i++;
      j++;
    } else {
      // Look ahead for matches
      const baseFound = compareWords.indexOf(baseWords[i], j);
      const compareFound = baseWords.indexOf(compareWords[j], i);
      
      if (baseFound !== -1 && (compareFound === -1 || baseFound - j <= compareFound - i)) {
        result.push({ word: compareWords[j], type: type === 'base' ? 'none' : 'added' });
        j++;
      } else if (compareFound !== -1) {
        result.push({ word: baseWords[i], type: type === 'base' ? 'removed' : 'none' });
        i++;
      } else {
        if (type === 'base') {
          result.push({ word: baseWords[i], type: 'removed' });
        } else {
          result.push({ word: compareWords[j], type: 'added' });
        }
        i++;
        j++;
      }
    }
  }
  
  return result;
}

// Generate combined view with markup
function generateCombinedView(baseDiff, compareDiff) {
  const words = [];
  
  for (let i = 0; i < Math.max(baseDiff.length, compareDiff.length); i++) {
    const baseWord = baseDiff[i];
    const compareWord = compareDiff[i];
    
    if (baseWord && baseWord.type === 'removed') {
      words.push({
        word: baseWord.word,
        type: 'removed',
        symbol: '-'
      });
    } else if (compareWord && compareWord.type === 'added') {
      words.push({
        word: compareWord.word,
        type: 'added',
        symbol: '+'
      });
    } else if (baseWord && baseWord.type === 'same') {
      words.push({
        word: baseWord.word,
        type: 'same',
        symbol: ' '
      });
    }
  }
  
  return words;
}

// Calculate similarity percentage
function calculateSimilarity(baseWords, compareWords) {
  const lcs = longestCommonSubsequence(baseWords, compareWords);
  const maxLen = Math.max(baseWords.length, compareWords.length);
  return maxLen === 0 ? 100 : Math.round((lcs.length / maxLen) * 100);
}

// LCS algorithm
function longestCommonSubsequence(arr1, arr2) {
  const m = arr1.length;
  const n = arr2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (arr1[i - 1] === arr2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  
  const lcs = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (arr1[i - 1] === arr2[j - 1]) {
      lcs.unshift(arr1[i - 1]);
      i--;
      j--;
    } else {
      if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }
  }
  
  return lcs;
}

// AI Analysis endpoint (optional OpenRouter)
app.post('/api/analyze', async (req, res) => {
  try {
    const { baseContent, compareContent, baseHtml, compareHtml, baseId, compareId } = req.body;
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    
    if (!openRouterKey) {
      // Return basic analysis without AI
      return res.json(getBasicAnalysis(baseContent, compareContent, baseHtml, compareHtml));
    }
    
    const prompt = `
You are a healthcare document expert analyzing changes between two patient records.
Compare these two versions and provide:
1. Summary of key changes
2. Clinical significance of changes
3. Formatting changes detected (bold, italics, indentation)
4. Risk assessment if any

BASE DOCUMENT:
${baseContent.substring(0, 2000)}

UPDATED DOCUMENT:
${compareContent.substring(0, 2000)}

Provide analysis in JSON format with fields: summary, clinicalSignificance, formattingChanges, riskAssessment
`;
    
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: 'openai/gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3
    }, {
      headers: {
        'Authorization': `Bearer ${openRouterKey}`,
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'Healthcare Doc Comparison'
      }
    });
    
    const analysis = JSON.parse(response.data.choices[0].message.content);
    res.json(analysis);
  } catch (error) {
    res.json(getBasicAnalysis(req.body.baseContent, req.body.compareContent, req.body.baseHtml, req.body.compareHtml));
  }
});

// Basic analysis without AI
function getBasicAnalysis(baseContent, compareContent, baseHtml, compareHtml) {
  const baseText = baseHtml ? stripHtmlToText(baseHtml) : String(baseContent || '');
  const compareText = compareHtml ? stripHtmlToText(compareHtml) : String(compareContent || '');
  const baseWords = baseText.split(/\s+/).filter(Boolean).length;
  const compareWords = compareText.split(/\s+/).filter(Boolean).length;
  const diff = compareWords - baseWords;
  
  return {
    summary: `Document has ${Math.abs(diff)} ${diff > 0 ? 'added' : 'removed'} words`,
    clinicalSignificance: 'Review changes carefully for patient safety',
    formattingChanges: detectFormattingChanges(baseContent, compareContent, baseHtml, compareHtml),
    riskAssessment: 'Standard review recommended'
  };
}

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n')
    .replace(/<\s*\/div\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function collectHtmlFormatStats(html) {
  const text = String(html || '');
  const boldTagCount = (text.match(/<\s*(b|strong)\b/gi) || []).length;
  const italicTagCount = (text.match(/<\s*(i|em)\b/gi) || []).length;

  const styleMatches = [...text.matchAll(/style\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
  const colorValues = new Set();
  const fontFamilies = new Set();
  const fontSizes = new Set();
  let boldStyleCount = 0;
  let italicStyleCount = 0;

  styleMatches.forEach(style => {
    const lower = style.toLowerCase();
    const colorMatch = lower.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
    if (colorMatch) colorValues.add(colorMatch[1].trim());
    const fontFamilyMatch = lower.match(/(?:^|;)\s*font-family\s*:\s*([^;]+)/i);
    if (fontFamilyMatch) fontFamilies.add(fontFamilyMatch[1].trim());
    const fontSizeMatch = lower.match(/(?:^|;)\s*font-size\s*:\s*([^;]+)/i);
    if (fontSizeMatch) fontSizes.add(fontSizeMatch[1].trim());
    if (/(?:^|;)\s*font-weight\s*:\s*(bold|[6-9]00)\b/i.test(lower)) boldStyleCount++;
    if (/(?:^|;)\s*font-style\s*:\s*italic\b/i.test(lower)) italicStyleCount++;
  });

  return {
    boldCount: boldTagCount + boldStyleCount,
    italicCount: italicTagCount + italicStyleCount,
    colors: colorValues,
    fonts: fontFamilies,
    sizes: fontSizes
  };
}

// Detect formatting changes
function detectFormattingChanges(baseContent, compareContent, baseHtml, compareHtml) {
  const changes = [];
  const hasHtml = baseHtml || compareHtml;

  if (hasHtml) {
    const baseStats = collectHtmlFormatStats(baseHtml);
    const compareStats = collectHtmlFormatStats(compareHtml);

    if (baseStats.boldCount !== compareStats.boldCount) {
      changes.push('Bold formatting changed');
    }
    if (baseStats.italicCount !== compareStats.italicCount) {
      changes.push('Italic formatting changed');
    }
    if (baseStats.colors.size !== compareStats.colors.size || [...baseStats.colors].some(c => !compareStats.colors.has(c))) {
      changes.push('Font color changed');
    }
    if (baseStats.fonts.size !== compareStats.fonts.size || [...baseStats.fonts].some(f => !compareStats.fonts.has(f))) {
      changes.push('Font family changed');
    }
    if (baseStats.sizes.size !== compareStats.sizes.size || [...baseStats.sizes].some(s => !compareStats.sizes.has(s))) {
      changes.push('Font size changed');
    }
    if (String(baseHtml || '').replace(/\s+/g, ' ') !== String(compareHtml || '').replace(/\s+/g, ' ')) {
      // Keep spacing/indentation as a separate signal so layout-only changes are not missed.
      const baseBreaks = (String(baseHtml || '').match(/<\s*br\s*\/?\s*>|<\s*\/p\s*>|<\s*\/div\s*>/gi) || []).length;
      const compareBreaks = (String(compareHtml || '').match(/<\s*br\s*\/?\s*>|<\s*\/p\s*>|<\s*\/div\s*>/gi) || []).length;
      if (baseBreaks !== compareBreaks) changes.push('Indentation/spacing changed');
    }
  } else if (baseContent.includes('**') !== compareContent.includes('**')) {
    changes.push('Bold formatting changed');
  }
  if (!hasHtml && baseContent.includes('*') !== compareContent.includes('*')) {
    changes.push('Italic formatting changed');
  }
  if (!hasHtml && baseContent.match(/\n\n/g)?.length !== compareContent.match(/\n\n/g)?.length) {
    changes.push('Indentation/spacing changed');
  }
  
  return changes.length > 0 ? changes : ['No formatting changes detected'];
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
