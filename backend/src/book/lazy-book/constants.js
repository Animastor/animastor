const BookState = {
    RAW_IMPORTED: 'RAW_IMPORTED',
    BOOTSTRAPPED: 'BOOTSTRAPPED',
    ACTIVE: 'ACTIVE',
};

const SceneStatus = {
    NOT_PARSED: 'NOT_PARSED',
    PARSING: 'PARSING',
    PARSED: 'PARSED',
    GENERATED: 'GENERATED',
};

const SourceType = {
    TXT: 'TXT',
    AI_IMPORT: 'AI_IMPORT',
};

const UnitType = {
    TYPOGRAPHY: 'typography',
    TALKING_HEAD: 'talking_head',
    TRANSITION: 'transition',
    PERCEPTION: 'perception',
    DIALOGUE: 'dialogue',
    PERFORMANCE: 'performance',
};

const DEFAULT_WINDOW_SIZE = 3;

module.exports = {
    BookState, SceneStatus, SourceType, UnitType, DEFAULT_WINDOW_SIZE,
};
