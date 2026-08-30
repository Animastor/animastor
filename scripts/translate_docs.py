#!/usr/bin/env python3
"""
Documentation Language Audit Script
Analyzes markdown files for Russian content and categorizes them.
"""

import os
import re
import sys
from pathlib import Path
from collections import defaultdict

CYRILLIC_RE = re.compile(r'[а-яА-ЯёЁ]')
NON_CODE_BLOCK_RE = re.compile(r'```.*?```', re.DOTALL)

def analyze_file(filepath):
    """Analyze a file for Russian content distribution."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        return None
    
    # Remove code blocks for analysis
    content_no_code = NON_CODE_BLOCK_RE.sub('', content)
    
    # Remove inline code
    content_no_code = re.sub(r'`[^`]+`', '', content_no_code)
    
    # Remove URLs
    content_no_code = re.sub(r'https?://\S+', '', content_no_code)
    content_no_code = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', content_no_code)
    
    total_chars = len(content_no_code.strip())
    if total_chars == 0:
        return None
    
    # Count Cyrillic characters
    cyrillic_chars = len(CYRILLIC_RE.findall(content_no_code))
    
    # Count total words (approximate)
    words = content_no_code.split()
    total_words = len(words)
    if total_words == 0:
        return None
    
    # Count Cyrillic words (words that contain Cyrillic)
    cyrillic_words = sum(1 for w in words if CYRILLIC_RE.search(w))
    
    # Calculate percentages
    cyrillic_pct = (cyrillic_words / total_words * 100) if total_words > 0 else 0
    cyrillic_char_pct = (cyrillic_chars / total_chars * 100) if total_chars > 0 else 0
    
    # Categorize
    if cyrillic_pct < 1:
        category = "EN"
    elif cyrillic_pct < 30:
        category = "MIXED_LIGHT"
    elif cyrillic_pct < 70:
        category = "MIXED_HEAVY"
    else:
        category = "RU"
    
    return {
        'total_words': total_words,
        'cyrillic_words': cyrillic_words,
        'cyrillic_pct': round(cyrillic_pct, 1),
        'cyrillic_char_pct': round(cyrillic_char_pct, 1),
        'category': category,
        'total_chars': total_chars,
        'cyrillic_chars': cyrillic_chars
    }

def scan_directory(root_dir):
    """Scan all markdown files in the directory."""
    results = []
    
    for root, dirs, files in os.walk(root_dir):
        # Skip node_modules, .git, frontends, tools
        skip = False
        for skip_dir in ['node_modules', '.git', 'frontends', 'tools']:
            if skip_dir in root:
                skip = True
                break
        if skip:
            continue
        
        for f in files:
            if f.endswith('.md'):
                filepath = os.path.join(root, f)
                rel_path = os.path.relpath(filepath, root_dir)
                analysis = analyze_file(filepath)
                if analysis:
                    results.append({
                        'path': rel_path,
                        **analysis
                    })
    
    return results

def main():
    root = '.'
    if len(sys.argv) > 1:
        root = sys.argv[1]
    
    results = scan_directory(root)
    
    # Sort by category and then by cyrillic percentage
    results.sort(key=lambda x: (
        {'RU': 0, 'MIXED_HEAVY': 1, 'MIXED_LIGHT': 2, 'EN': 3}[x['category']],
        -x['cyrillic_pct']
    ))
    
    # Print summary
    categories = defaultdict(list)
    for r in results:
        categories[r['category']].append(r)
    
    print(f"\n{'='*80}")
    print(f"DOCUMENTATION LANGUAGE AUDIT REPORT")
    print(f"{'='*80}\n")
    
    print(f"Total files scanned: {len(results)}")
    print(f"  EN (pure English): {len(categories['EN'])}")
    print(f"  MIXED_LIGHT (<30% RU): {len(categories['MIXED_LIGHT'])}")
    print(f"  MIXED_HEAVY (30-70% RU): {len(categories['MIXED_HEAVY'])}")
    print(f"  RU (mostly Russian): {len(categories['RU'])}")
    
    for cat in ['RU', 'MIXED_HEAVY', 'MIXED_LIGHT']:
        if categories[cat]:
            print(f"\n{'='*80}")
            print(f"CATEGORY: {cat}")
            print(f"{'='*80}")
            for r in categories[cat]:
                print(f"  {r['path']}: {r['cyrillic_pct']}% RU ({r['cyrillic_words']}/{r['total_words']} words)")

if __name__ == '__main__':
    main()
