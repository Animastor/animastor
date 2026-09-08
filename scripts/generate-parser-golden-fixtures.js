// One-off generator: emits golden fixtures from the REAL deterministic
// detector (structure-detector.buildDeterministicMap) + the C13 legacy
// projection. Run: node scripts/generate-parser-golden-fixtures.js
// The output is committed; re-run only when the contract version bumps.
const fs = require('fs');
const path = require('path');

const { buildDeterministicMap } = require('../backend/src/services/structure-detector');
const { mapToLegacyChapters } = require('../packages/animastor-vbook-runtime/src/contracts/legacy-projection');

const prose = (t) => t.repeat(3);

const FIXTURES = [
    {
        name: 'single-chapter-ru',
        description: 'One explicit "Глава 1" chapter covering the whole text.',
        text: [
            'Глава 1. Начало',
            '',
            prose('Утро выдалось тихим, и город ещё не проснулся. Он шёл по пустой улице, слушая, как под ногами хрустит свежий песок, и думал о том, что всё только начинается. '),
        ].join('\n'),
    },
    {
        name: 'multiple-chapters-ru',
        description: 'Three numbered chapters in reading order.',
        text: [
            'Глава 1. Земля',
            '',
            prose('Юра, инженер по искусственному интеллекту, всё чаще замечал странный парадокс: чем совершеннее становились технологии, тем реже человек пытался понять самого себя. '),
            '',
            'Глава 2. Первый полёт',
            '',
            prose('Пока большинство людей спорило о будущем, небольшая группа инженеров, учёных и исследователей просто начала его строить. Настал день первого пилотируемого полёта. '),
            '',
            'Глава 3. Процветание',
            '',
            prose('Прошли годы. Кольцевая станция превратилась в живой научный город, где технологии помогали человеку раскрывать собственные способности. '),
        ].join('\n'),
    },
    {
        name: 'prologue-chapters-epilogue-ru',
        description: 'Title+author line, prologue, two chapters, epilogue.',
        text: [
            'За пределами алгоритмов. С.А. Хабаров.',
            '',
            'Пролог. Мир на переломе эпох',
            '',
            prose('Первая половина XXI века стала временем стремительного научного прогресса. Искусственный интеллект научился решать задачи, которые ещё недавно считались исключительно человеческими. '),
            '',
            'Глава 1. Земля',
            '',
            prose('Юра, инженер по искусственному интеллекту, всё чаще замечал странный парадокс: чем совершеннее становились технологии, тем реже человек пытался понять самого себя. '),
            '',
            'Глава 2. Первый полёт',
            '',
            prose('Пока большинство людей спорило о будущем, небольшая группа инженеров, учёных и исследователей просто начала его строить. '),
            '',
            'Эпилог. Новый рассвет',
            '',
            prose('Прошли годы. Кольцевая станция превратилась в живой научный город, и город встретил новый рассвет. '),
        ].join('\n'),
    },
    {
        name: 'no-explicit-chapters-ru',
        description: 'Bare narrative without any headings: single body segment, no title.',
        text: prose('Она открыла дверь и вошла. В комнате пахло кофе и старой бумагой. Кто-то ждал её у окна, и этот кто-то не обернулся, когда скрипнула половица. '),
    },
    {
        name: 'russian-titled-body',
        description: 'Russian title line + body text without chapters.',
        text: [
            'Тихая осень в старом городе',
            '',
            prose('Снег ложился на крыши домов, и город засыпал под тёплым одеялом тумана. Фонари мерцали редкими островками света, отражаясь в мокром асфальте. '),
        ].join('\n'),
    },
    {
        name: 'english-chapters-en',
        description: 'English title + two numbered chapters.',
        text: [
            'The Long Road Home',
            '',
            'John Smith',
            '',
            'Chapter 1. Departure',
            '',
            prose('The morning train pulled out of the station under a grey sky, and Thomas watched the city dissolve into fields and rivers he had never learned to name. '),
            '',
            'Chapter 2. Arrival',
            '',
            prose('By the time the letter reached him, the road home had already changed its shape, and the house at the end of it no longer waited for anyone. '),
        ].join('\n'),
    },
];

const out = {
    contractVersion: 1,
    note: 'Golden fixtures for the C13 Parser contract. Each fixture records the canonical ParserResult produced by buildDeterministicMap plus its legacy chapter projection (splitIntoChapters). Offsets anchor the exact "text" instance. Regenerate only on a contract version bump.',
    fixtures: FIXTURES.map(({ name, description, text }) => {
        const map = buildDeterministicMap(text);
        return {
            name,
            description,
            text,
            expectedMap: map,
            expectedLegacyChapters: mapToLegacyChapters(map, text),
        };
    }),
};

const target = path.join(__dirname, '..', 'backend', 'tests', 'fixtures', 'parser-contract', 'golden', 'parser-golden-fixtures.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('written:', target);
for (const f of out.fixtures) {
    console.log(`- ${f.name}: segments=${f.expectedMap.segments.map(s => `${s.type}[${s.startOffset},${s.endOffset})`).join(', ')}, title=${JSON.stringify(f.expectedMap.title && f.expectedMap.title.text)}, author=${JSON.stringify(f.expectedMap.author && f.expectedMap.author.text)}`);
}
