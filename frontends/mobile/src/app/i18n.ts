// i18n — словари ru/en из res/values/strings.xml и res/values-ru/strings.xml.
// Порядок ключей 1:1 с R.string.* (полный список снимается по мере реализации экранов).

export type Lang = 'ru' | 'en';

const dict = {
  ru: {
    // Bottom Navigation (strings.xml ru — uppercase, 1:1)
    tab_file: 'ФАЙЛ',
    tab_generate: 'ГЕНЕРАТОР',
    tab_play: 'ПЛЕЕР',
    tab_edit: 'РЕДАКТОР',
    tab_navigate: 'НАВИГАТОР',
    // Toolbar / secondary
    settings: 'Настройки',
    settings_title: 'Настройки',
    ai: 'AI-ассистент',
    back: 'Назад',
    library_title: 'Библиотека',
    workflow_manager_title: 'Менеджер Workflow',
    workflow: 'Workflow',
    developer_tools: 'Инструменты разработчика',
    vbook_settings_title: 'Настройки генерации VBook',
    worker_settings_title: 'Настройки генерации',
    // Placeholder
    coming_soon: 'Скоро',
    // Play Screen (strings.xml ru)
    play_placeholder: 'Откройте книгу для начала воспроизведения',
    play_placeholder_no_generation: 'Начните генерацию. Перейдите на вкладку «Генератор».',
    play_generate_hint: 'Нажмите «Генерировать» для начала',
    play_loading: 'Загрузка…',
    play_ready: 'Готово',
    play_playing: 'Воспроизведение…',
    play_paused: 'Пауза',
    play_play: 'СТАРТ',
    play_pause: 'ПАУЗА',
    play_fullscreen: 'Полный экран',
    iu_not_generated: 'Не сгенерировано',
    layer_audio: 'Аудио',
    layer_image: 'Изображение',
    layer_video: 'Видео',
    layer_subtitles: 'Субтитры',
    // Legacy empty states
    empty_state: 'Выберите визуальную книгу из библиотеки.',
    empty_state_book_loaded: 'Книга загружена. Нажмите «Генерировать».',
    upload_failed: 'Ошибка загрузки',
    // Settings (strings.xml ru)
    settings_theme: 'Тема',
    settings_theme_auto: 'Авто — по времени суток',
    settings_theme_dark: 'Тёмный кинозал',
    settings_theme_light: 'Светлый кинозал',
    settings_language: 'Язык',
    settings_language_auto: 'Авто — как в системе',
    settings_language_en: 'Английский',
    settings_language_ru: 'Русский'
  },
  en: {
    // Bottom Navigation (strings.xml en — uppercase, 1:1)
    tab_file: 'FILE',
    tab_generate: 'GENERATE',
    tab_play: 'PLAY',
    tab_edit: 'EDIT',
    tab_navigate: 'NAVIGATE',
    // Toolbar / secondary
    settings: 'Settings',
    settings_title: 'Settings',
    ai: 'AI Assistant',
    back: 'Back',
    library_title: 'Library',
    workflow_manager_title: 'Workflow Manager',
    workflow: 'Workflow',
    developer_tools: 'Developer Tools',
    vbook_settings_title: 'VBook Generation Settings',
    worker_settings_title: 'Generation Settings',
    // Placeholder
    coming_soon: 'Coming soon',
    // Play Screen (strings.xml en)
    play_placeholder: 'Open a book to start playback',
    play_placeholder_no_generation: 'Start generation. Go to the GENERATE tab.',
    play_generate_hint: 'Press GENERATE to start',
    play_loading: 'Loading…',
    play_ready: 'Ready',
    play_playing: 'Playing…',
    play_paused: 'Paused',
    play_play: 'PLAY',
    play_pause: 'PAUSE',
    play_fullscreen: 'Fullscreen',
    iu_not_generated: 'Not generated',
    layer_audio: 'Audio',
    layer_image: 'Image',
    layer_video: 'Video',
    layer_subtitles: 'Subtitles',
    // Legacy empty states
    empty_state: 'Choose a visual book from the library.',
    empty_state_book_loaded: 'Book loaded. Press GENERATE to start.',
    upload_failed: 'Upload failed',
    // Settings (strings.xml en)
    settings_theme: 'Theme',
    settings_theme_auto: 'Auto — by time of day',
    settings_theme_dark: 'Dark Cinema',
    settings_theme_light: 'Light Cinema',
    settings_language: 'Language',
    settings_language_auto: 'Auto — follow system',
    settings_language_en: 'English',
    settings_language_ru: 'Russian'
  }
} as const;

export type StrKey = keyof typeof dict['en'];

export function currentLang(): Lang {
  return (document.documentElement.getAttribute('lang') as Lang) === 'ru' ? 'ru' : 'en';
}

export function t(key: StrKey, fallback?: string): string {
  return dict[currentLang()][key] ?? fallback ?? key;
}
