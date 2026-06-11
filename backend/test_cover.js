const book = require('./src/book');
const fs = require('fs');

// Simulate the extraction and build
const buffer = fs.readFileSync('../json_book.zip');

async function test() {
  const files = book.extractBookBundle(buffer);
  console.log('=== FILES ===');
  Object.keys(files).forEach(f => console.log(f));
  
  // Parse manifest directly
  const manifest = JSON.parse(files['manifest.json']);
  console.log('\n=== MANIFEST ===');
  console.log(JSON.stringify(manifest, null, 2));
  
  const built = book.buildBookFromBundle(files);
  console.log('\n=== BUILT BOOK ===');
  console.log('Chapters:', built.chapters.length);
  built.chapters.forEach((ch, i) => {
    console.log('Chapter', i, ':', ch.chapter, 'scenes:', ch.scenes?.length || 0);
    if (ch.scenes) {
      ch.scenes.forEach((sc, j) => {
        console.log('  Scene', j, ':', sc.scene_id, 'type:', sc.type, 'style:', sc.style);
        if (sc.audio?.full_text) {
          console.log('    Audio text:', sc.audio.full_text.substring(0, 50) + '...');
        }
      });
    }
  });
}

test().catch(console.error);
