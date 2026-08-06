const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
// BOOKS_DIR must be set before lazy-book is loaded (runtime-config reads it at
// require time). Always use a fresh temp dir so tests never touch real books.
process.env.BOOKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vbook-unit-'));
const sd = require('../src/services/structure-detector');
const parser = require('../src/book/lazy-book/parser');
const chapterUtils = require('../src/book/lazy-book/chapter-utils');
const lazyBook = require('../src/book/lazy-book');
const pipelineRunner = require('../src/services/agent/pipeline-runner');
const textUtils = require('../src/services/agent/text-utils');

// Test book fixture — mirrors the real import test file (title + author on
// one line, prologue with its own heading, three numbered chapters).
const BOOK = [
    'За пределами алгоритмов. С.А. Хабаров.',
    '',
    'Пролог. Мир на переломе эпох',
    '',
    'Первая половина XXI века стала временем стремительного научного прогресса. Искусственный интеллект научился решать задачи, которые ещё недавно считались исключительно человеческими. Биотехнологии приблизились к лечению неизлечимых болезней, робототехника изменила промышленность, а космические проекты вновь стали частью повседневной жизни.',
    'Но очень быстро чудеса перестали казаться чудесами. Люди привыкли к ним так же, как когда-то привыкли к электричеству, интернету и смартфонам.',
    'При этом сам мир не стал спокойнее. Военные конфликты продолжались, общества всё сильнее разделялись, а алгоритмы всё чаще определяли, какие новости увидит человек, во что он поверит и с кем окажется по одну сторону очередного спора.',
    '',
    'Глава 1. Земля',
    '',
    'Юра, инженер по искусственному интеллекту, всё чаще замечал странный парадокс: чем совершеннее становились технологии, тем реже человек пытался понять самого себя.',
    'Светлана, исследователь когнитивной инженерии, пришла к похожему выводу. Она изучала, как человек способен осознанно менять собственные мыслительные привычки и выходить за пределы автоматических реакций.',
    'Постепенно они поняли, что главная проблема будущего — не недостаток технологий. Главная проблема — научиться пользоваться ими, не теряя свободы мышления.',
    '',
    'Глава 2. Первый полёт',
    '',
    'Пока большинство людей спорило о будущем, небольшая группа инженеров, учёных и исследователей просто начала его строить.',
    'Настал день первого пилотируемого полёта.',
    'Юра улыбнулся.',
    '— Ну что… поехали?',
    '',
    'Глава 3. Процветание',
    '',
    'Прошли годы.',
    'Кольцевая станция превратилась в живой научный город, где технологии помогали человеку раскрывать собственные способности.',
].join('\n');

function candidateIds(text) {
    const ids = {};
    for (const c of sd.extractCandidates(text).candidates) ids[c.text] = c.id;
    return ids;
}

describe('structure-detector (v2)', () => {
    describe('buildDeterministicMap — classic book', () => {
        let map;
        before(() => { map = sd.buildDeterministicMap(BOOK); });

        it('extracts title and author from a "Title. Author" first line', () => {
            expect(map.title.text).to.equal('За пределами алгоритмов');
            expect(map.author.text).to.equal('С.А. Хабаров');
        });

        it('detects the prologue', () => {
            expect(map.hasPrologue).to.equal(true);
        });

        it('produces prologue + 3 chapters in order with correct types/numbers', () => {
            expect(map.segments.map(s => s.type)).to.deep.equal(['prologue', 'chapter', 'chapter', 'chapter']);
            expect(map.segments[0].title).to.equal('Мир на переломе эпох');
            expect(map.segments[1].title).to.equal('Земля');
            expect(map.segments[1].number).to.equal(1);
            expect(map.segments[2].title).to.equal('Первый полёт');
            expect(map.segments[2].number).to.equal(2);
            expect(map.segments[3].title).to.equal('Процветание');
            expect(map.segments[3].number).to.equal(3);
        });

        it('keeps offsets contiguous and covering the whole text', () => {
            expect(map.segments[0].startOffset).to.equal(0 + BOOK.indexOf('Пролог. Мир'));
            expect(map.segments[map.segments.length - 1].endOffset).to.equal(BOOK.length);
            for (let i = 1; i < map.segments.length; i++) {
                expect(map.segments[i].startOffset).to.equal(map.segments[i - 1].endOffset);
            }
        });

        it('does not split on dialogue lines or sentence-like lines', () => {
            const titles = map.segments.map(s => s.title);
            expect(titles).to.not.include('Настал день первого пилотируемого полёта.');
        });
    });

    describe('universality — no forced structure', () => {
        it('poem without headings → single body segment, no title', () => {
            const poem = 'Тишина\n\nЛуна плывёт над спящею землёй,\nИ тихий ветер трогает листву.';
            const map = sd.buildDeterministicMap(poem);
            expect(map.title).to.equal(null);
            expect(map.segments.map(s => s.type)).to.deep.equal(['body']);
            expect(map.segments[0].title).to.equal(null);
        });

        it('few sentences → single body segment', () => {
            const frag = 'Она открыла дверь и вошла. В комнате пахло кофе. Кто-то ждал её у окна.';
            const map = sd.buildDeterministicMap(frag);
            expect(map.segments.map(s => s.type)).to.deep.equal(['body']);
        });

        it('title + direct text (no chapters) → title + body, no forced "Глава 1"', () => {
            const t = 'Зимний вечер\n\nСнег ложился на крыши домов. Город засыпал под тёплым одеялом тумана.';
            const map = sd.buildDeterministicMap(t);
            expect(map.title.text).to.equal('Зимний вечер');
            expect(map.segments.map(s => s.type)).to.deep.equal(['body']);
        });

        it('title and author on separate lines (with initials)', () => {
            const t = 'За пределами алгоритмов\n\nС.А. Хабаров\n\nПролог. Мир на переломе эпох\n\nТекст пролога, достаточно длинный, чтобы быть самостоятельным абзацем повествования без всякой другой структуры.';
            const map = sd.buildDeterministicMap(t);
            expect(map.title.text).to.equal('За пределами алгоритмов');
            expect(map.author.text).to.equal('С.А. Хабаров');
        });
    });

    describe('mergeAiDecisions', () => {
        it('applies LLM decisions onto the deterministic backbone', () => {
            const ids = candidateIds(BOOK);
            const ai = {
                title: { text: 'За пределами алгоритмов', candidate_id: ids[BOOK.split('\n')[0]], confidence: 0.95 },
                author: { text: 'С.А. Хабаров', candidate_id: ids[BOOK.split('\n')[0]], confidence: 0.7 },
                elements: [
                    { candidate_id: ids['Пролог. Мир на переломе эпох'], kind: 'prologue', title: 'Мир на переломе эпох', confidence: 0.95 },
                    { candidate_id: ids['Глава 1. Земля'], kind: 'chapter', title: 'Земля', number: 1, confidence: 0.98 },
                    { candidate_id: ids['Глава 2. Первый полёт'], kind: 'chapter', title: 'Первый полёт', number: 2, confidence: 0.98 },
                    { candidate_id: ids['Глава 3. Процветание'], kind: 'chapter', title: 'Процветание', number: 3, confidence: 0.98 },
                ],
            };
            const map = sd.mergeAiDecisions(BOOK, ai);
            expect(map.title.text).to.equal('За пределами алгоритмов');
            expect(map.author.text).to.equal('С.А. Хабаров');
            expect(map.segments.map(s => s.type)).to.deep.equal(['prologue', 'chapter', 'chapter', 'chapter']);
            expect(map.segments.map(s => s.title)).to.deep.equal(['Мир на переломе эпох', 'Земля', 'Первый полёт', 'Процветание']);
            expect(map.segments.every(s => s.source === 'ai')).to.equal(true);
        });
    });

    describe('hallucination guard', () => {
        it('rejects invented title/author/elements and keeps the deterministic map', () => {
            const ids = candidateIds(BOOK);
            const poison = {
                title: { text: 'На этой странице нет никакой книги', confidence: 0.99 },
                author: { text: '999 не существует', confidence: 0.9 },
                elements: [
                    { candidate_id: 'c999', kind: 'chapter', title: 'Выдуманная глава', number: 1, confidence: 0.99 },
                    { candidate_id: ids['Глава 1. Земля'], kind: 'chapter', title: '', number: 9999, confidence: 0.2 },
                    { candidate_id: ids['Глава 2. Первый полёт'], kind: 'heading', confidence: 0.9 },
                    { candidate_id: ids['Глава 3. Процветание'], kind: 'chapter', title: 'Процветание', number: 3, confidence: 0.95 },
                ],
            };
            const map = sd.mergeAiDecisions(BOOK, poison);
            expect(map.title.text).to.equal('За пределами алгоритмов');
            expect(map.author.text).to.equal('С.А. Хабаров');
            const segs = map.segments.map(s => s.title);
            expect(segs).to.include('Земля');
            expect(segs).to.include('Процветание');
        });

        it('keeps an element with an empty title (titleless chapter) instead of dropping the boundary', () => {
            const ids = candidateIds(BOOK);
            const map = sd.mergeAiDecisions(BOOK, {
                elements: [
                    { candidate_id: ids['Глава 1. Земля'], kind: 'chapter', title: '', number: 1, confidence: 0.95 },
                    { candidate_id: ids['Глава 2. Первый полёт'], kind: 'chapter', title: '', number: 2, confidence: 0.95 },
                ],
            });
            const titles = map.segments.map(s => s.title);
            expect(titles).to.include('Земля');
            expect(titles).to.include('Первый полёт');
            expect(map.segments.filter(s => s.type === 'chapter').length).to.be.at.least(2);
        });

        it('rejects a hallucinated author anchored to the title line (no author in source)', () => {
            const ids = candidateIds(BOOK);
            const titleLine = BOOK.split('\n')[0]; // "За пределами алгоритмов. С.А. Хабаров."
            const hallucinated = {
                title: { text: 'За пределами алгоритмов', candidate_id: ids[titleLine], confidence: 0.95 },
                // LLM invented an author and anchored it to the SAME line as the
                // title — the line text does not contain the author name.
                author: { text: 'Пётр Иванов', candidate_id: ids[titleLine], confidence: 0.8 },
                elements: [],
            };
            const map = sd.mergeAiDecisions(BOOK, hallucinated);
            // Deterministic backbone detected the REAL author from the line split.
            expect(map.title.text).to.equal('За пределами алгоритмов');
            expect(map.author.text).to.equal('С.А. Хабаров');
        });

        it('rejects an invented author when the book has no author at all', () => {
            const noAuthorBook = 'За пределами алгоритмов\n\nПролог. Мир на переломе эпох\n\nПервая половина XXI века стала временем стремительного научного прогресса. Искусственный интеллект научился решать задачи, которые ещё недавно считались исключительно человеческими. Биотехнологии приблизились к лечению неизлечимых болезней, робототехника изменила промышленность, а космические проекты вновь стали частью повседневной жизни.\nНо очень быстро чудеса перестали казаться чудесами. Люди привыкли к ним так же, как когда-то привыкли к электричеству, интернету и смартфонам.\nПри этом сам мир не стал спокойнее. Военные конфликты продолжались, общества всё сильнее разделялись, а алгоритмы всё чаще определяли, какие новости увидит человек, во что он поверит и с кем окажется по одну сторону очередного спора.';
            const ids = candidateIds(noAuthorBook);
            const hallucinated = {
                title: { text: 'За пределами алгоритмов', candidate_id: ids['За пределами алгоритмов'], confidence: 0.95 },
                author: { text: 'С.А. Хабаров', candidate_id: ids['За пределами алгоритмов'], confidence: 0.8 },
                elements: [],
            };
            const map = sd.mergeAiDecisions(noAuthorBook, hallucinated);
            expect(map.title.text).to.equal('За пределами алгоритмов');
            expect(map.author).to.equal(null);
        });

        it('keeps author when the line is a real "Title. Author" one-liner', () => {
            const ids = candidateIds(BOOK);
            const titleLine = BOOK.split('\n')[0];
            const map = sd.mergeAiDecisions(BOOK, {
                title: { text: 'За пределами алгоритмов', candidate_id: ids[titleLine], confidence: 0.95 },
                author: { text: 'С.А. Хабаров', candidate_id: ids[titleLine], confidence: 0.8 },
                elements: [],
            });
            expect(map.author.text).to.equal('С.А. Хабаров');
        });

        it('sanitizeStructure drops a title that looks like a full sentence', () => {
            const ids = candidateIds(BOOK);
            const out = sd.sanitizeStructure({
                title: { text: 'Это слишком длинное предложение, чтобы быть названием книги вообще', confidence: 0.99 },
                elements: [],
            }, sd.extractCandidates(BOOK).candidates);
            expect(out.title).to.equal(undefined);
        });
    });

    describe('splitIntoChapters (lazy-book integration)', () => {
        it('prologue is chapter index 0 with type/label/number fields', () => {
            const chapters = parser.splitIntoChapters(BOOK);
            expect(chapters.length).to.equal(4);
            expect(chapters[0].type).to.equal('prologue');
            expect(chapters[0].number).to.equal(null);
            expect(chapters[1].type).to.equal('chapter');
            expect(chapters[1].number).to.equal(1);
            expect(chapters[1].title).to.equal('Земля');
            // legacy contract intact
            expect(chapters[0].startOffset).to.be.a('number');
            expect(chapters[0].length).to.be.above(0);
            // contiguous coverage
            expect(chapters[chapters.length - 1].endOffset).to.equal(BOOK.length);
        });

        it('unstructured text → single chapter', () => {
            const frag = 'Она открыла дверь и вошла. В комнате пахло кофе. Кто-то ждал её у окна.';
            expect(parser.splitIntoChapters(frag).length).to.equal(1);
        });
    });

    describe('createFromAnalysis integration (v2 chapter materialization)', () => {
        let bookId;
        before(() => {
            const draft = lazyBook.createDraftBook(BOOK, lazyBook.SourceType.TXT, 'test.txt');
            bookId = draft.bookId;
            const map = sd.buildDeterministicMap(BOOK);
            const structure = {
                title: map.title.text,
                author: map.author.text,
                has_prologue: map.hasPrologue,
                has_epilogue: map.hasEpilogue,
                parts: map.parts,
                chapters: sd.mapToStructureChapters(map),
                segments: map.segments,
                country: null,
                epoch: null,
            };
            let offset = map.segments[0].startOffset;
            for (let i = 0; i < map.segments.length; i++) {
                const win = pipelineRunner.getWindowText(BOOK, [], [], i, offset, 3, { chapterMap: map.segments });
                const scenes = textUtils.buildFallbackScenes(win.fullChapter);
                if (i === 0) {
                    lazyBook.createFromAnalysis(bookId, {
                        characters: [], locations: [], mentions: {},
                        scenes, chapterTitle: win.chapterTitle, maxScenes: 3, structure,
                    });
                } else {
                    lazyBook.appendToBook(bookId, {
                        characters: [], locations: [], mentions: {},
                        scenes, maxScenes: 3, chapterTitle: win.chapterTitle, chapterIndex: i, structure,
                    });
                }
                offset = win.currentOffset;
            }
        });

        it('writes title/author/has_prologue into book.json', () => {
            const bm = JSON.parse(fs.readFileSync(lazyBook.getBookMetaPath(lazyBook.getBookDir(bookId)), 'utf8'));
            expect(bm.title).to.equal('За пределами алгоритмов');
            expect(bm.author).to.equal('С.А. Хабаров');
            expect(bm.structure.has_prologue).to.equal(true);
        });

        it('creates cover + prologue(index 0) + 3 chapters, each as its own JSON with a typography intro', () => {
            const chDir = lazyBook.getChapterDir(lazyBook.getBookDir(bookId));
            const files = fs.readdirSync(chDir).filter(f => f.endsWith('.json')).sort();
            const chapters = files.map(f => JSON.parse(fs.readFileSync(path.join(chDir, f), 'utf8')));

            const cover = chapters.find(c => c.type === 'cover');
            expect(cover).to.exist;
            expect(cover.scenes[0].units[0].type).to.equal('typography');
            expect(cover.scenes[0].units[0].text).to.contain('За пределами алгоритмов');
            expect(cover.scenes[0].units[0].text).to.contain('С.А. Хабаров');

            const prologue = chapters.find(c => c.type === 'prologue');
            expect(prologue.chapter_index).to.equal(0);
            expect(prologue.chapter_title).to.equal('Пролог');
            expect(prologue.scenes[0].units[0].type).to.equal('typography');
            expect(prologue.scenes[0].units[0].text).to.equal('Пролог\nМир на переломе эпох');

            const numbered = chapters.filter(c => c.type === 'chapter').sort((a, b) => a.chapter_index - b.chapter_index);
            expect(numbered.length).to.equal(3);
            expect(numbered.map(c => c.chapter_title)).to.deep.equal(['Земля', 'Первый полёт', 'Процветание']);
            expect(numbered.map(c => c.chapter_index)).to.deep.equal([1, 2, 3]);
            for (const ch of numbered) {
                expect(ch.scenes[0].units[0].type).to.equal('typography');
            }
            expect(numbered[0].scenes[0].units[0].text).to.equal('Глава 1\nЗемля');
        });
    });

    describe('surname-frequency check (character vs author)', () => {
        it('splits a no-separator "Title ФИО" first line', () => {
            const t = 'За пределами алгоритмов С. А. Хабаров\n\nПролог. Мир на переломе эпох\n\n' +
                'Первая половина XXI века стала временем стремительного научного прогресса. Искусственный интеллект научился решать задачи, которые ещё недавно считались исключительно человеческими. Биотехнологии приблизились к лечению неизлечимых болезней, робототехника изменила промышленность.';
            const map = sd.buildDeterministicMap(t);
            expect(map.title.text).to.equal('За пределами алгоритмов');
            expect(map.author.text).to.equal('С. А. Хабаров');
        });

        it('splits a no-separator line with glued initials', () => {
            const t = 'За пределами алгоритмов С.А. Хабаров\n\nПролог. Мир на переломе эпох\n\n' +
                'Первая половина XXI века стала временем стремительного научного прогресса. Искусственный интеллект научился решать задачи, которые ещё недавно считались исключительно человеческими.';
            const map = sd.buildDeterministicMap(t);
            expect(map.title.text).to.equal('За пределами алгоритмов');
            expect(map.author.text).to.equal('С.А. Хабаров');
        });

        it('rejects an author whose surname appears in the narrative (character)', () => {
            // "Жизнь Хабарова" — the surname sits INSIDE the title text AND
            // appears in the narrative: it is a character, not an author. The
            // narrative paragraph is long enough to make the line a confident
            // title.
            const t = 'Жизнь Хабарова\n\nХабаров открыл глаза. Хабаров не помнил, как оказался здесь. Доктор Хабаров, известный нейрохирург, присел на край кровати и долго молчал, не зная, с чего начать разговор.';
            const map = sd.buildDeterministicMap(t);
            expect(map.title.text).to.equal('Жизнь Хабарова');
            expect(map.author).to.equal(null);
        });

        it('keeps an author whose surname is absent from the narrative', () => {
            const t = 'За пределами алгоритмов\n\nС.А. Хабаров\n\nПролог. Мир на переломе эпох\n\n' +
                'Первая половина XXI века стала временем стремительного научного прогресса. Искусственный интеллект научился решать задачи, которые ещё недавно считались исключительно человеческими. Никто не знал, куда заведёт этот путь.';
            const map = sd.buildDeterministicMap(t);
            expect(map.author.text).to.equal('С.А. Хабаров');
        });

        it('handles Russian declension when counting the surname', () => {
            expect(sd._countSurnameInText('Хабаров улыбнулся. Рядом стоял сын Хабарова.', 'Хабаров')).to.equal(2);
            expect(sd._countSurnameInText('книга о Хабарове и его открытиях', 'Хабаров')).to.equal(1);
            expect(sd._countSurnameInText('Обычный текст без фамилий.', 'Хабаров')).to.equal(0);
        });

        it('mergeAiDecisions drops an agent author whose surname appears in the narrative', () => {
            const src = 'За пределами алгоритмов. С.А. Хабаров.\n\nПролог\n\nХабаров пришёл в себя. Хабаров не помнил вчерашнего вечера. Инспектор Хабаров достал блокнот.';
            const ids = candidateIds(src);
            const ai = {
                title: { text: 'За пределами алгоритмов', candidate_id: ids[src.split('\n')[0]], confidence: 0.95 },
                author: { text: 'С.А. Хабаров', candidate_id: ids[src.split('\n')[0]], confidence: 0.8 },
                elements: [],
            };
            const map = sd.mergeAiDecisions(src, ai);
            // The author is dropped, and the CLEAN split title survives (not the
            // whole line with the character name glued to it).
            expect(map.author).to.equal(null);
            expect(map.title.text).to.equal('За пределами алгоритмов');
        });

        it('no-initials "Title Имя Фамилия" is NOT split deterministically (name may be inside the title)', () => {
            // "За пределами алгоритмов Иван Петров" — two name words without
            // initials. The deterministic path deliberately requires an initial
            // (otherwise "Жизнь Хабарова" would split into Жизнь + Хабарова).
            // The LLM path handles name+surname; here the whole line is a title.
            const t = 'За пределами алгоритмов Иван Петров\n\nПролог. Мир на переломе эпох\n\nПервая половина XXI века стала временем стремительного научного прогресса. Искусственный интеллект научился решать задачи, которые ещё недавно считались исключительно человеческими.';
            const map = sd.buildDeterministicMap(t);
            expect(map.title.text).to.equal('За пределами алгоритмов Иван Петров');
            expect(map.author).to.equal(null);
        });

        it('keeps an agent author whose surname never appears in the narrative', () => {
            const ids = candidateIds(BOOK);
            const titleLine = BOOK.split('\n')[0];
            const map = sd.mergeAiDecisions(BOOK, {
                title: { text: 'За пределами алгоритмов', candidate_id: ids[titleLine], confidence: 0.95 },
                author: { text: 'С.А. Хабаров', candidate_id: ids[titleLine], confidence: 0.8 },
                elements: [],
            });
            expect(map.author.text).to.equal('С.А. Хабаров');
        });
    });

    describe('chapter-template learning (Мастер и Маргарита style)', () => {
        // Русское издание: автор первой строкой, название ниже, "Глава N" +
        // ALL-CAPS заголовок отдельной строкой, афиша внутри главы, диапазон
        // годов в конце книги.
        const MIM = [
            'Михаил Афанасиевич Булгаков',
            '',
            'Мастер и Маргарита',
            '',
            'ЧАСТЬ ПЕРВАЯ',
            '',
            'Глава 1',
            'НИКОГДА НЕ РАЗГОВАРИВАЙТЕ С НЕИЗВЕСТНЫМИ',
            '',
            'Однажды весною, в час небывало жаркого заката, в Москве, на Патриарших прудах, появились два гражданина. Первый из них, одетый в летнюю серенькую пару, был маленького роста, упитан, лыс, свою приличную шляпу пирожком нёс в руке, а на хорошо выбритом лице его помещались сверхъестественных размеров очки в чёрной роговой оправе.',
            'Второй был плечистый, рыжеватый, вихрастый молодой человек в заломленной на затылок клетчатой кепке — из-под неё выбивался белый, очень высокий чуб.',
            '— Позвольте, а вы кто такой? — сердито спросил Иван и, попятившись, спрятал молоток за спину.',
            '',
            'Глава 10',
            'ВЕСТИ ИЗ ЯЛТЫ',
            '',
            'ПРОФЕССОР ВОЛАНД',
            'В тот же день, к вечеру, в Москве распространилась весть о том, что сеанс чёрной магии окончился скандалом, а столица потрясена небывалым происшествием.',
            '',
            'Глава 30',
            'ПОРА! ПОРА!',
            '',
            '— Ты меня отпускаешь уже? — прошептал мастер. — Нет, я подожду тебя, и мы уйдём вместе.',
            '',
            'ЭПИЛОГ',
            '',
            'В течение многих лет, во всех концах страны, произносились разговоры о нечистой силе, появившейся в Москве. Люди рассказывали, что никакой нечистой силы не было вовсе.',
            '',
            '1929 — 1940',
        ].join('\n');

        let map;
        before(() => { map = sd.buildDeterministicMap(MIM); });

        it('inverted title page: author on first line, title below', () => {
            expect(map.title.text).to.equal('Мастер и Маргарита');
            expect(map.author.text).to.equal('Михаил Афанасиевич Булгаков');
        });

        it('detects the epilogue', () => {
            expect(map.hasEpilogue).to.equal(true);
        });

        it('parts are decorative — no part segments', () => {
            expect(map.segments.filter(s => s.type === 'part').length).to.equal(0);
        });

        it('multi-line headers merge: keyword line + ALL-CAPS title line, even with comma/!', () => {
            const byHeader = Object.fromEntries(map.segments.map(s => [s.headerLine, s]));
            expect(byHeader['Глава 1'].title).to.equal('НИКОГДА НЕ РАЗГОВАРИВАЙТЕ С НЕИЗВЕСТНЫМИ');
            expect(byHeader['Глава 10'].title).to.equal('ВЕСТИ ИЗ ЯЛТЫ');
            expect(byHeader['Глава 30'].title).to.equal('ПОРА! ПОРА!');
        });

        it('template fires: poster text without a keyword is not a chapter', () => {
            // "ПРОФЕССОР ВОЛАНД" is an interior poster inside Глава 10 — the
            // chapter template ("Глава N" + ALL-CAPS title) proves it is not a
            // boundary, so it must NOT appear as a headerLine.
            const headers = map.segments.map(s => s.headerLine);
            expect(headers).to.not.include('ПРОФЕССОР ВОЛАНД');
            expect(map.segments.filter(s => s.type === 'chapter').length).to.equal(3);
        });

        it('date range at the end of the book is not a chapter', () => {
            const headers = map.segments.map(s => s.headerLine);
            expect(headers).to.not.include('1929 — 1940');
        });

        it('chapter numbers continue in reading order', () => {
            const chapters = map.segments.filter(s => s.type === 'chapter');
            expect(chapters.map(s => s.number)).to.deep.equal([1, 2, 3]);
        });

        it('far-away multi-line poster (real MiM aфиша) is still dropped', () => {
            // Реальная афиша Мастера и Маргариты: постер "ПРОФЕССОР ВОЛАНД"
            // стоит НЕ рядом с "Глава N" (в реальной книге — 28 строк ниже),
            // а за ним идёт вторая короткая строка афиши (не абзац, без точки).
            // Признак (a) не сработает, но (b) — многострочный постер — должен.
            const poster = [
                'Глава 1',
                'ПЕРВАЯ ГЛАВА',
                '',
                'Утро началось с дождя. Город ещё спал, когда раздался первый звонок. На столе остывал чай, а за окном медленно светлело небо.',
                'К полудню тучи рассеялись, и солнце залило улицы. Люди выходили из домов, щурились и улыбались друг другу.',
                'Вечером вновь пошёл дождь, но это уже никого не волновало — день удался. И только в театре Варьете готовились к вечернему представлению.',
                'Варенуха, отойдя от афиши, наброшенной им на макет, полюбовался на неё и приказал кассирше продавать билеты, не глядя на звонки.',
                'Кассирша, выслушав приказание, захлопотала и понеслась в кассу, а Варенуха, потирая руки, заглянул в будку, где уже собиралась публика.',
                '',
                'Сегодня и ежедневно в театре Варьете сверх программы:',
                '',
                'ПРОФЕССОР ВОЛАНД',
                '',
                'Сеансы черной магии с полным ее разоблачением',
                '',
                'Варенуха, отойдя от афиши, наброшенной им на макет, полюбовался на неё. Всё было в порядке.',
                'Он приказал кассирше не задерживать публику и сам вышел на улицу, где уже толпился народ.',
                '',
                'Глава 2',
                'ВТОРАЯ ГЛАВА',
                '',
                'Наутро город выглядел иначе. Вчерашний дождь смыл пыль, и воздух стал прозрачным, как стекло.',
                'Они встретились на вокзале ровно в девять. Поезд уже подавали, и проводница нетерпеливо поглядывала на часы.',
            ].join('\n');
            const m = sd.buildDeterministicMap(poster);
            const headers = m.segments.map(s => s.headerLine);
            expect(headers).to.not.include('ПРОФЕССОР ВОЛАНД');
            expect(headers).to.not.include('Сеансы черной магии с полным ее разоблачением');
            expect(m.segments.filter(s => s.type === 'chapter').length).to.equal(2);
        });

        it('mixed-style book: a far-away unkeyworded section stays a chapter (distance-scoped drop)', () => {
            // Первые главы — keyword-style ("Глава 1" + ALL-CAPS). Позже в книге
            // идёт НЕнумерованная секция далеко от заголовка предыдущей главы
            // — постер-фильтр не должен её проглотить (она не "приклеена" к
            // keyword-заголовку).
            const mixed = [
                'Глава 1',
                'ПЕРВЫЙ ДЕНЬ',
                '',
                'Утро началось с дождя. Город ещё спал, когда раздался первый звонок. На столе остывал чай, а за окном медленно светлело небо.',
                'К полудню тучи рассеялись, и солнце залило улицы. Люди выходили из домов, щурились и улыбались друг другу.',
                'Вечером вновь пошёл дождь, но это уже никого не волновало — день удался.',
                '',
                'Глава 2',
                'ВТОРОЙ ДЕНЬ',
                '',
                'Наутро город выглядел иначе. Вчерашний дождь смыл пыль, и воздух стал прозрачным, как стекло.',
                'Они встретились на вокзале ровно в девять. Поезд уже подавали, и проводница нетерпеливо поглядывала на часы.',
                'Разговор не клеился, но молчание было тёплым и совсем не тягостным.',
                '',
                'ВМЕСТО ЭПИЛОГА',
                '',
                'Прошло десять лет. Те, кто помнил те два дня, рассказывали о них по-разному, но сходились в главном: всё началось с дождя.',
                'Город изменился, люди изменились, и только старый вокзал стоял на прежнем месте.',
                'История не закончилась — она просто стала чьей-то памятью.',
            ].join('\n');
            const m = sd.buildDeterministicMap(mixed);
            const headers = m.segments.map(s => s.headerLine);
            // Постер-фильтр (template) сработал для "Глава 1/2", но дальняя
            // ненумерованная секция сохранилась как отдельная глава.
            expect(headers).to.include('ВМЕСТО ЭПИЛОГА');
            expect(m.segments.filter(s => s.type === 'chapter').length).to.equal(3);
        });

        it('without the template (no keyword chapters) standalone ALL-CAPS lines still split', () => {
            // Книга без слова "Глава": ALL-CAPS заголовки сами по себе — границы.
            const plain = 'Начало истории. Первые строки этого романа о том, как всё начиналось и что произошло дальше.\n\n' +
                'ПЕРВАЯ ЧАСТЬ\n\nТекст первой части этого романа, достаточно длинный, чтобы считаться уверенным абзацем повествования о событиях того времени.\n\n' +
                'ВТОРАЯ ЧАСТЬ\n\nТекст второй части, тоже длинный и самостоятельный, рассказывает о том, что случилось потом с героями этой истории.';
            const m = sd.buildDeterministicMap(plain);
            const chapters = m.segments.filter(s => s.type === 'chapter');
            expect(chapters.length).to.be.at.least(2);
            expect(chapters[0].title).to.equal('ПЕРВАЯ ЧАСТЬ');
        });
    });

    describe('inverted title page with initials author (С.А. Хабаров)', () => {
        // Реальный кейс ba_1786022092582: автор первой строкой (инициалы +
        // фамилия — 2 токена), название ниже с декоративной точкой.
        const INVERTED = [
            'С.А. Хабаров',
            '',
            'За пределами алгоритмов.',
            '',
            'Пролог. Мир на переломе эпох',
            '',
            'Первая половина XXI века стала временем стремительного научного прогресса. Искусственный интеллект научился решать задачи, которые ещё недавно считались исключительно человеческими. Биотехнологии приблизились к лечению неизлечимых болезней, робототехника изменила промышленность, а космические проекты вновь стали частью повседневной жизни.',
            'Но очень быстро чудеса перестали казаться чудесами. Люди привыкли к ним так же, как когда-то привыкли к электричеству, интернету и смартфонам.',
            '',
            'Глава 1. Земля',
            '',
            'Юра, инженер по искусственному интеллекту, всё чаще замечал странный парадокс: чем совершеннее становились технологии, тем реже человек пытался понять самого себя.',
            'Светлана, исследователь когнитивной инженерии, пришла к похожему выводу. Она изучала, как человек способен осознанно менять собственные мыслительные привычки.',
        ].join('\n');

        it('initials+surname first line is the AUTHOR, the title line below wins (trailing period stripped)', () => {
            const map = sd.buildDeterministicMap(INVERTED);
            expect(map.title.text).to.equal('За пределами алгоритмов');
            expect(map.author.text).to.equal('С.А. Хабаров');
            expect(map.hasPrologue).to.equal(true);
            expect(map.segments[0].title).to.equal('Мир на переломе эпох');
        });

        it('a two-word title without initials is NOT misread as an author', () => {
            const t = 'Анна Каренина\n\nВсе счастливые семьи похожи друг на друга, каждая несчастливая семья несчастлива по-своему. Всё смешалось в доме Облонских, и этот длинный абзац делает первую строку уверенным названием.';
            const map = sd.buildDeterministicMap(t);
            expect(map.title.text).to.equal('Анна Каренина');
            expect(map.author).to.equal(null);
        });

        it('mergeAiDecisions anchors an LLM title that drops the trailing period', () => {
            const ids = candidateIds(INVERTED);
            const titleLine = 'За пределами алгоритмов.';
            const ai = {
                // LLM вернула название БЕЗ декоративной точки — якорь должен
                // найтись через нормализацию пунктуации, а не быть выброшенным.
                title: { text: 'За пределами алгоритмов', candidate_id: ids[titleLine], confidence: 0.95 },
                author: { text: 'С.А. Хабаров', candidate_id: ids['С.А. Хабаров'], confidence: 0.9 },
                elements: [],
            };
            const map = sd.mergeAiDecisions(INVERTED, ai);
            expect(map.title.text).to.equal('За пределами алгоритмов');
            expect(map.author.text).to.equal('С.А. Хабаров');
        });

        it('sanitizeStructure anchors title line_text without the trailing period', () => {
            const out = sd.sanitizeStructure({
                title: { text: 'За пределами алгоритмов', line_text: 'За пределами алгоритмов', confidence: 0.95 },
                elements: [],
            }, sd.extractCandidates(INVERTED).candidates);
            expect(out.title.text).to.equal('За пределами алгоритмов');
        });

        it('only the trailing PERIOD is stripped — meaningful ?/!/… in a title survives', () => {
            const t = 'А.И. Герцен\n\nКто виноват?\n\nВсе счастливые семьи похожи друг на друга. Этот длинный абзац повествования нужен, чтобы вторая строка осталась уверенным кандидатом на название, а не прозой.';
            const map = sd.buildDeterministicMap(t);
            expect(map.title.text).to.equal('Кто виноват?');
            expect(map.author.text).to.equal('А.И. Герцен');
        });

        it('epigraph attribution above a title is treated as an inverted title page (documented trade-off)', () => {
            // «К. Симонов» + название — структурно неотличимо от инвертированного
            // титула; детерминированный путь даёт автор+название (название
            // восстанавливается корректно), LLM-мерж может переопределить автора.
            const t = 'К. Симонов\n\nМоя книга\n\nЭто длинный абзац первой главы, достаточно большой, чтобы быть уверенным повествованием после титульных строк.';
            const map = sd.buildDeterministicMap(t);
            expect(map.title.text).to.equal('Моя книга');
            expect(map.author.text).to.equal('К. Симонов');
        });
    });

    describe('buildSegmentIntro (typography scenes)', () => {
        it('prologue → «Пролог» + title, narrator-voiced', () => {
            const intro = chapterUtils.buildSegmentIntro(
                { type: 'prologue', title: 'Мир на переломе эпох', number: null, label: 'Пролог' }, 'ru');
            expect(intro.text).to.equal('Пролог\nМир на переломе эпох');
            expect(intro.scene_title).to.equal('Пролог');
        });

        it('chapter → «Глава N» + title', () => {
            const intro = chapterUtils.buildSegmentIntro(
                { type: 'chapter', title: 'Земля', number: 1, label: 'Глава' }, 'ru');
            expect(intro.text).to.equal('Глава 1\nЗемля');
        });

        it('body/poem → null (no forced title card)', () => {
            expect(chapterUtils.buildSegmentIntro({ type: 'body', title: null }, 'ru')).to.equal(null);
        });

        it('english chapter label', () => {
            const intro = chapterUtils.buildSegmentIntro(
                { type: 'chapter', title: 'Earth', number: 1, label: 'Chapter' }, 'en');
            expect(intro.text).to.equal('Chapter 1\nEarth');
        });
    });
});
