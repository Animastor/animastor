// i18n — словари ru/en из res/values/strings.xml и res/values-ru/strings.xml.
// Порядок ключей 1:1 с R.string.* (полный список снимается по мере реализации экранов).

export type Lang = 'ru' | 'en';

const dict = {
  ru: {
    tab_file: 'Файл',
    tab_generate: 'Генерация',
    tab_play: 'Play',
    tab_edit: 'Редакт',
    tab_navigate: 'Навигация',
    settings: 'Настройки',
    ai: 'AI-ассистент',
    back: 'Назад',
    play_placeholder: 'Откройте книгу, чтобы начать',
    play_placeholder_no_generation: 'Книга загружена. Запустите генерацию',
    play_generate_hint: 'Запустите генерацию во вкладке «Генерация»',
    play_loading: 'Загрузка…',
    play_ready: 'Готово',
    play_playing: 'Воспроизведение',
    play_paused: 'Пауза',
    play_play: 'Play',
    play_pause: 'Pause',
    play_fullscreen: 'Полный экран',
    iu_not_generated: 'Не сгенерировано',
    layer_audio: 'Аудио',
    layer_image: 'Изображение',
    layer_video: 'Видео',
    layer_subtitles: 'Субтитры',
    empty_state: 'Откройте книгу во вкладке «Файл»',
    empty_state_book_loaded: 'Книга загружена',
    upload_failed: 'Загрузка не удалась',
    settings_theme: 'Тема',
    settings_language: 'Язык',
    settings_auto: 'Авто',
    settings_dark: 'Тёмная',
    settings_light: 'Светлая'
  },
  en: {
    tab_file: 'File',
    tab_generate: 'Generate',
    tab_play: 'Play',
    tab_edit: 'Edit',
    tab_navigate: 'Navigate',
    settings: 'Settings',
    ai: 'AI Assistant',
    back: 'Back',
    play_placeholder: 'Open a book to start',
    play_placeholder_no_generation: 'Book loaded. Run generation',
    play_generate_hint: 'Start generation on the Generate tab',
    play_loading: 'Loading…',
    play_ready: 'Ready',
    play_playing: 'Playing',
    play_paused: 'Paused',
    play_play: 'Play',
    play_pause: 'Pause',
    play_fullscreen: 'Fullscreen',
    iu_not_generated: 'Not generated',
    layer_audio: 'Audio',
    layer_image: 'Image',
    layer_video: 'Video',
    layer_subtitles: 'Subtitles',
    empty_state: 'Open a book on the File tab',
    empty_state_book_loaded: 'Book loaded',
    upload_failed: 'Upload failed',
    settings_theme: 'Theme',
    settings_language: 'Language',
    settings_auto: 'Auto',
    settings_dark: 'Dark',
    settings_light: 'Light'
  }
} as const;

export type StrKey = keyof typeof dict['en'];

export function currentLang(): Lang {
  return (document.documentElement.getAttribute('lang') as Lang) === 'ru' ? 'ru' : 'en';
}

export function t(key: StrKey, fallback?: string): string {
  return dict[currentLang()][key] ?? fallback ?? key;
}
