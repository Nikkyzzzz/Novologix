const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const axios = require('axios');

// Configuration
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

// Multer configuration
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['application/pdf', 'text/plain', 'application/msword'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and TXT files are allowed'));
    }
  }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));
app.use(express.static('public'));

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// In-memory storage for documents
const documents = new Map();
let documentCounter = 0;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Extract text from PDF file
 */
async function extractPdfText(filePath) {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text;
  } catch (error) {
    throw new Error(`PDF parsing failed: ${error.message}`);
  }
}

/**
 * Extract text from TXT file
 */
async function extractTxtText(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

/**
 * Detect formatting in text
 */
function detectFormatting(text) {
  const formatting = {
    hasBold: /\*\*.*?\*\*/.test(text) || /__.*?__/.test(text),
    hasItalic: /\*.*?\*/.test(text) || /_.*?_/.test(text),
    hasHeadings: /^#{1,6}\s/m.test(text),
    hasLists: /^[\-\*\+]\s/m.test(text),
    hasLinks: /\[.*?\]\(.*?\)/.test(text),
    hasTables: /\|.*?\|/m.test(text),
    indentationLevels: (text.match(/^\s+/gm) || []).length,
    paragraphCount: (text.match(/\n\n+/g) || []).length
  };
  return formatting;
}

/**
 * Longest Common Subsequence algorithm
 */
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

/**
 * Generate word-based diff
 */
function generateDiff(baseWords, compareWords, type) {
  const result = [];
  let i = 0, j = 0;

  while (i < baseWords.length || j < compareWords.length) {
    if (i >= baseWords.length) {
      result.push({
        word: compareWords[j],
        type: type === 'base' ? 'none' : 'added'
      });
      j++;
    } else if (j >= compareWords.length) {
      result.push({
        word: baseWords[i],
        type: type === 'base' ? 'removed' : 'none'
      });
      i++;
    } else if (baseWords[i].toLowerCase() === compareWords[j].toLowerCase()) {
      result.push({
        word: baseWords[i],
        type: 'same'
      });
      i++;
      j++;
    } else {
      const baseFound = compareWords.findIndex(
        (w, idx) => idx >= j && w.toLowerCase() === baseWords[i].toLowerCase()
      );
      const compareFound = baseWords.findIndex(
        (w, idx) => idx >= i && w.toLowerCase() === compareWords[j].toLowerCase()
      );

      if (baseFound !== -1 && (compareFound === -1 || baseFound - j <= compareFound - i)) {
        result.push({
          word: compareWords[j],
          type: type === 'base' ? 'none' : 'added'
        });
        j++;
      } else if (compareFound !== -1) {
        result.push({
          word: baseWords[i],
          type: type === 'base' ? 'removed' : 'none'
        });
        i++;
      } else {
        if (type === 'base') {
          result.push({
            word: baseWords[i],
            type: 'removed'
          });
        } else {
          result.push({
            word: compareWords[j],
            type: 'added'
          });
        }
        i++;
        j++;
      }
    }
  }

  return result;
}

/**
 * Generate combined view with markup
 */
function generateCombinedView(baseDiff, compareDiff) {
  const words = [];
  const used = new Set();

  for (let i = 0; i < Math.max(baseDiff.length, compareDiff.length); i++) {
    const key = `${i}`;
    if (used.has(key)) continue;

    const baseWord = baseDiff[i];
    const compareWord = compareDiff[i];

    if (baseWord?.type === 'removed') {
      words.push({
        word: baseWord.word,
        type: 'removed',
        symbol: '-'
      });
      used.add(key);
    } else if (compareWord?.type === 'added') {
      words.push({
        word: compareWord.word,
        type: 'added',
        symbol: '+'
      });
      used.add(key);
    } else if (baseWord?.type === 'same') {
      words.push({
        word: baseWord.word,
        type: 'same',
        symbol: ' '
      });
      used.add(key);
    }
  }

  return words;
}

/**
 * Calculate similarity percentage
 */
function calculateSimilarity(baseWords, compareWords) {
  const lcs = longestCommonSubsequence(baseWords, compareWords);
  const maxLen = Math.max(baseWords.length, compareWords.length);
  return maxLen === 0 ? 100 : Math.round((lcs.length / maxLen) * 100);
}

/**
 * Compare two documents
 */
function compareDocuments(baseText, compareText) {
  const baseWords = baseText
    .split(/\s+/)
    .filter(w => w.length > 0)
    .map(w => w.toLowerCase());
  const compareWords = compareText
    .split(/\s+/)
    .filter(w => w.length > 0)
    .map(w => w.toLowerCase());

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
    stats: {
      baseWords: baseWords.length,
      compareWords: compareWords.length,
      addedWords: compareDiff.filter(w => w.type === 'added').length,
      removedWords: baseDiff.filter(w => w.type === 'removed').length,
      similarity: calculateSimilarity(baseWords, compareWords),
      baseFormatting: detectFormatting(baseText),
      compareFormatting: detectFormatting(compareText)
    }
  };
}

// ============================================================================
// BASIC ANALYSIS (Without AI)
// ============================================================================

function getBasicAnalysis(baseContent, compareContent) {
  const baseWords = baseContent.split(/\s+/).length;
  const compareWords = compareContent.split(/\s+/).length;
  const diff = compareWords - baseWords;

  const baseFormatting = detectFormatting(baseContent);
  const compareFormatting = detectFormatting(compareContent);

  const formattingChanges = [];
  if (baseFormatting.hasBold !== compareFormatting.hasBold) {
    formattingChanges.push('Bold formatting changed');
  }
  if (baseFormatting.hasItalic !== compareFormatting.hasItalic) {
    formattingChanges.push('Italic formatting changed');
  }
  if (baseFormatting.indentationLevels !== compareFormatting.indentationLevels) {
    formattingChanges.push('Indentation levels changed');
  }
  if (Math.abs(baseFormatting.paragraphCount - compareFormatting.paragraphCount) > 2) {
    formattingChanges.push('Document structure changed');
  }

  return {
    summary: `Document has ${Math.abs(diff)} ${diff > 0 ? 'added' : diff < 0 ? 'removed' : ''} words. ${diff > 0 ? 'Document expanded' : diff < 0 ? 'Document condensed' : 'Same length'}.`,
    clinicalSignificance: 'Review changes carefully for patient safety and care continuity. Pay attention to medication changes, diagnosis updates, and vital sign modifications.',
    formattingChanges: formattingChanges.length > 0 ? formattingChanges : ['No formatting changes detected'],
    riskAssessment: diff > 50 ? 'Comprehensive review recommended due to substantial changes' : 'Standard review recommended'
  };
}

// ============================================================================
// ENDPOINTS
// ============================================================================

/**
 * Upload endpoint
 */
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const fileName = req.body.name || file.originalname;

    let content = '';
    if (file.mimetype === 'application/pdf') {
      content = await extractPdfText(file.path);
    } else {
      content = await extractTxtText(file.path);
    }

    // Validate content
    if (!content || content.trim().length === 0) {
      throw new Error('File appears to be empty');
    }

    const docId = `doc_${documentCounter++}`;
    documents.set(docId, {
      id: docId,
      name: fileName,
      content: content,
      createdAt: new Date(),
      type: file.mimetype,
      size: file.size
    });

    // Clean up uploaded file
    fs.unlinkSync(file.path);

    res.json({
      id: docId,
      name: fileName,
      preview: content.substring(0, 200),
      wordCount: content.split(/\s+/).length
    });
  } catch (error) {
    res.status(400).json({
      error: error.message || 'Upload failed'
    });
  }
});

/**
 * Get all documents
 */
app.get('/api/documents', (req, res) => {
  const docs = Array.from(documents.values()).map(doc => ({
    id: doc.id,
    name: doc.name,
    preview: doc.content.substring(0, 150),
    wordCount: doc.content.split(/\s+/).length,
    size: doc.size,
    createdAt: doc.createdAt
  }));
  res.json(docs);
});

/**
 * Get specific document
 */
app.get('/api/documents/:id', (req, res) => {
  const doc = documents.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json(doc);
});

/**
 * Update document
 */
app.put('/api/documents/:id', (req, res) => {
  const doc = documents.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  if (!req.body.content) {
    return res.status(400).json({ error: 'Content is required' });
  }

  doc.content = req.body.content;
  doc.updatedAt = new Date();

  res.json({
    ...doc,
    wordCount: doc.content.split(/\s+/).length
  });
});

/**
 * Delete document
 */
app.delete('/api/documents/:id', (req, res) => {
  if (documents.delete(req.params.id)) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Document not found' });
  }
});

/**
 * Compare documents
 */
app.post('/api/compare', (req, res) => {
  try {
    const { baseId, compareId, baseContent, compareContent } = req.body;

    let baseText = baseContent;
    let compareText = compareContent;

    // If IDs provided, fetch from storage
    if (baseId && !baseContent) {
      const baseDoc = documents.get(baseId);
      if (!baseDoc) return res.status(404).json({ error: 'Base document not found' });
      baseText = baseDoc.content;
    }

    if (compareId && !compareContent) {
      const compareDoc = documents.get(compareId);
      if (!compareDoc) return res.status(404).json({ error: 'Compare document not found' });
      compareText = compareDoc.content;
    }

    if (!baseText || !compareText) {
      return res.status(400).json({ error: 'Both documents required' });
    }

    const comparison = compareDocuments(baseText, compareText);
    res.json(comparison);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * AI Analysis endpoint
 */
app.post('/api/analyze', async (req, res) => {
  try {
    const { baseContent, compareContent } = req.body;

    if (!baseContent || !compareContent) {
      return res.status(400).json({ error: 'Both contents required' });
    }

    // If no OpenRouter key, return basic analysis
    if (!OPENROUTER_KEY) {
      return res.json(getBasicAnalysis(baseContent, compareContent));
    }

    // Use AI analysis
    const prompt = `
You are a healthcare document expert analyzing changes between two patient records or medical documents.

Compare these two documents and provide analysis in JSON format with these exact fields:
- summary: Brief overview of changes (2-3 sentences)
- clinicalSignificance: Impact on patient care (2-3 sentences)
- formattingChanges: Array of formatting changes detected
- riskAssessment: Risk level and recommendations (2-3 sentences)

BASE DOCUMENT:
${baseContent.substring(0, 2000)}

UPDATED DOCUMENT:
${compareContent.substring(0, 2000)}

Respond ONLY with valid JSON, no markdown formatting.`;

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'openai/gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 500
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
          'HTTP-Referer': 'http://localhost:' + PORT,
          'X-Title': 'HealthDoc Compare'
        }
      }
    );

    const responseText = response.data.choices[0].message.content;
    const analysis = JSON.parse(responseText);
    res.json(analysis);
  } catch (error) {
    console.error('Analysis error:', error.message);
    // Fallback to basic analysis
    res.json(getBasicAnalysis(req.body.baseContent, req.body.compareContent));
  }
});

/**
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    documentCount: documents.size,
    serverTime: new Date().toISOString(),
    version: '1.0.0',
    features: {
      pdfSupport: true,
      realTimeEditing: true,
      aiAnalysis: !!OPENROUTER_KEY,
      formattingDetection: true
    }
  });
});

/**
 * 404 handler
 */
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

/**
 * Error handler
 */
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: err.message || 'Internal server error'
  });
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║          HealthDoc Compare - Server Started                ║
╠════════════════════════════════════════════════════════════╣
║ Server:   http://localhost:${PORT}                             ║
║ Status:   ✓ Ready                                           ║
║ Mode:     ${process.env.NODE_ENV || 'development'}                            ║
║ AI Mode:  ${OPENROUTER_KEY ? '✓ Enabled' : '✗ Disabled (basic analysis)'}              ║
╚════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
