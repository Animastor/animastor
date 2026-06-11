// ======================================================
// Encoding Detection and Decoding
// ======================================================
// Tries multiple encodings to decode a buffer into text.
// Uses iconv-lite for conversion and heuristic scoring.
// ======================================================

const iconv = require('iconv-lite');

const ENCODING_ORDER = [
    'utf-8',
    'win1251',
    'cp1251',
    'koi8-r',
    'cp1252',
    'iso-8859-5',
    'ibm866',
];

const ENCODING_LABELS = {
    'utf-8': 'UTF-8',
    'win1251': 'Windows-1251',
    'cp1251': 'Windows-1251',
    'koi8-r': 'KOI8-R',
    'cp1252': 'CP1252 (Western European)',
    'iso-8859-5': 'ISO-8859-5',
    'ibm866': 'IBM866 (DOS Cyrillic)',
};

// BOM signatures
const BOMS = [
    { bytes: [0xEF, 0xBB, 0xBF], encoding: 'utf-8', name: 'UTF-8 BOM' },
    { bytes: [0xFF, 0xFE], encoding: 'utf-16le', name: 'UTF-16 LE' },
    { bytes: [0xFE, 0xFF], encoding: 'utf-16be', name: 'UTF-16 BE' },
];

// ======================================================
// DETECT BOM
// ======================================================

function detectBom(buffer) {
    for (const bom of BOMS) {
        if (buffer.length >= bom.bytes.length) {
            let match = true;
            for (let i = 0; i < bom.bytes.length; i++) {
                if (buffer[i] !== bom.bytes[i]) { match = false; break; }
            }
            if (match) return bom;
        }
    }
    return null;
}

// ======================================================
// SCORE DECODED TEXT
// ======================================================
// Higher score = more likely to be correct encoding

function scoreText(text) {
    let score = 0;
    let cyrillicCount = 0;
    let latinCount = 0;
    let controlCount = 0;
    let spaceCount = 0;
    let punctCount = 0;
    let totalChars = 0;
    let upperCyrillicCount = 0;
    let wordCount = 0;
    let validWordCount = 0;

    const allowedControls = new Set([9, 10, 13]);

    // Common Russian word fragments (bigrams that should appear in valid Russian text)
    const ruBigrams = new Set([
        'ст','но','то','на','по','пр','ра','ов','ал','ан','ен','ел','ол','ни',
        'ро','ло','ко','во','ос','ка','за','че','го','не','да','ли','та','ск',
        'ма','сп','со','тр','ве','ла','ме','де','те','ре','ль','ль','ки','ва',
        'чи','жд','жд','бе','зы','из','уж','жа','ша','ща','чу','щу','цы','це',
        'ря','бя','др','гр','пл','бл','кл','фр','хр','чр','шр','щр',
        'ое','ая','ых','их','ег','ом','ем','ей','ой','ии','ые','ие','ую','юю',
        'ать','ить','сть','тся','лся','ной','ный','ная','ное','ные',
    ]);

    for (let i = 0; i < text.length; i++) {
        const cp = text.charCodeAt(i);
        totalChars++;

        if (cp >= 0x0400 && cp <= 0x04FF) {
            cyrillicCount++;
            score += 20;
            if (cp >= 0x0410 && cp <= 0x042F) upperCyrillicCount++;
        } else if (cp >= 0x0041 && cp <= 0x007A) {
            latinCount++;
            score += 10;
        } else if (cp >= 0x0030 && cp <= 0x0039) {
            score += 5;
        } else if (cp === 0x0020) {
            spaceCount++;
        } else if ((cp >= 0x0021 && cp <= 0x002F) || (cp >= 0x003A && cp <= 0x0040) ||
                   (cp >= 0x005B && cp <= 0x0060) || (cp >= 0x007B && cp <= 0x007E)) {
            punctCount++;
            score += 2;
        } else if (cp < 0x0020 && !allowedControls.has(cp)) {
            controlCount++;
            score -= 50;
        } else if (cp >= 0x0080 && cp < 0x0400) {
            score -= 5;
        } else if (cp >= 0x2000 && cp <= 0x206F) {
            score += 2;
        } else if (cp === 0xFFFD) {
            score -= 100;
        }
    }

    // Check for Russian word fragments (bigrams)
    const lower = text.toLowerCase();
    for (const bg of ruBigrams) {
        let idx = 0;
        let cnt = 0;
        while ((idx = lower.indexOf(bg, idx)) !== -1) {
            cnt++;
            idx += 2;
        }
        if (cnt > 0) {
            score += cnt * 3;
            validWordCount += cnt;
        }
    }

    // Bonus for reasonable ratios
    if (totalChars > 0) {
        const contentRatio = (cyrillicCount + latinCount + punctCount + spaceCount) / totalChars;
        if (contentRatio > 0.5) score += 20;
        if (contentRatio > 0.8) score += 30;
        
        // Strong bonus if mostly Cyrillic (Russian text)
        if (cyrillicCount > latinCount && cyrillicCount > 5) score += 50;
        
        // Penalize if too many uppercase Cyrillic (indicates wrong encoding)
        if (cyrillicCount > 10) {
            const upperRatio = upperCyrillicCount / cyrillicCount;
            if (upperRatio > 0.7) score -= 30; // too many uppercase chars
            if (upperRatio < 0.05) score -= 20; // almost no uppercase
        }
    }

    return {
        score,
        cyrillicCount,
        latinCount,
        controlCount,
        totalChars,
        replacementCount: (text.match(/\uFFFD/g) || []).length,
        validWordCount,
    };
}

// ======================================================
// DECODE BUFFER WITH BEST GUESS ENCODING
// ======================================================

function isUtf8(buffer) {
    // Check if buffer is valid UTF-8 by decoding and counting replacement chars
    try {
        const text = buffer.toString('utf8');
        const replacements = (text.match(/\uFFFD/g) || []).length;
        // Valid UTF-8 should have no replacement characters from invalid byte sequences
        return replacements === 0;
    } catch {
        return false;
    }
}

function decodeBuffer(buffer) {
    // Check for binary
    if (buffer.indexOf(0) !== -1 && buffer.indexOf(0) < Math.min(buffer.length, 1024)) {
        return {
            text: null,
            encoding: null,
            error: 'File appears to be binary (not a text file)',
            warnings: [],
        };
    }

    if (buffer.length === 0) {
        return {
            text: null,
            encoding: null,
            error: 'File is empty',
            warnings: [],
        };
    }

    const warnings = [];
    const bom = detectBom(buffer);
    let strippedBuffer = buffer;

    if (bom) {
        warnings.push(`Detected BOM: ${bom.name}`);
        strippedBuffer = buffer.slice(bom.bytes.length);
    }

    // Prefer UTF-8 if valid
    if (isUtf8(strippedBuffer)) {
        const text = strippedBuffer.toString('utf8');
        console.log(`[ENCODING] UTF-8: ${text.length} chars`);
        return {
            text,
            encoding: 'utf-8',
            label: 'UTF-8',
            error: null,
            warnings,
            score: null,
        };
    }

    // UTF-8 failed — use byte-level heuristic to distinguish 8-bit encodings
    let byteHeuristic = null;
    {
        let c0df = 0, e0ff = 0;
        for (let i = 0; i < strippedBuffer.length; i++) {
            const b = strippedBuffer[i];
            if (b >= 0xC0 && b <= 0xDF) c0df++;
            else if (b >= 0xE0 && b <= 0xFF) e0ff++;
        }
        const total = c0df + e0ff;
        if (total > 10) {
            // Win1251: C0-DF = uppercase, E0-FF = lowercase → lowercase (~E0-FF) more common
            // KOI8-R:  C1-DF = lowercase, E1-FF = uppercase → lowercase (~C1-DF) more common
            if (e0ff > c0df * 1.8) byteHeuristic = 'win1251';
            else if (c0df > e0ff * 1.8) byteHeuristic = 'koi8-r';
        }
    }

    let bestResult = null;
    let bestScore = -Infinity;

    // Order: try byte-heuristic first, then the rest
    const tryOrder = byteHeuristic
        ? [byteHeuristic, ...ENCODING_ORDER.filter(e => e !== 'utf-8' && e !== byteHeuristic)]
        : ENCODING_ORDER.filter(e => e !== 'utf-8');

    for (const encName of tryOrder) {
        let decoded;
        try {
            if (iconv.encodingExists(encName)) {
                decoded = iconv.decode(strippedBuffer, encName);
            } else {
                continue;
            }
        } catch (e) {
            continue;
        }

        const scored = scoreText(decoded);

        // Skip if too many control characters
        if (scored.controlCount > decoded.length * 0.15 && decoded.length > 10) {
            continue;
        }

        // Skip if too many replacement chars
        if (scored.replacementCount > decoded.length * 0.05) {
            continue;
        }

        if (scored.score > bestScore) {
            bestScore = scored.score;
            bestResult = { text: decoded, encoding: encName, score: scored };
        }
    }

    if (!bestResult) {
        return {
            text: null,
            encoding: null,
            error: 'Could not decode file with any supported encoding',
            warnings,
        };
    }

    const label = ENCODING_LABELS[bestResult.encoding] || bestResult.encoding;
    warnings.push(`Detected encoding: ${label}`);

    console.log(`[ENCODING] ${label}: score=${bestResult.score.score}, ` +
        `cyrillic=${bestResult.score.cyrillicCount}, latin=${bestResult.score.latinCount}, ` +
        `replaced=${bestResult.score.replacementCount}, total=${bestResult.score.totalChars}`);

    return {
        text: bestResult.text,
        encoding: bestResult.encoding,
        label,
        error: null,
        warnings,
        score: bestResult.score,
    };
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = { decodeBuffer, detectBom, scoreText, ENCODING_LABELS };
