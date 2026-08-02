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
    toolbar_ai: 'ИИ',
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
    settings_language_ru: 'Русский',
    // VBook Settings (strings.xml ru)
    vbook_settings_scenes_per_pass: 'Сцен за раз',
    vbook_settings_scenes_per_pass_desc: 'Сколько сцен AI создаёт за один проход (1-5). Большие значения обрабатывают больше текста за проход, но увеличивают время на окно.',
    vbook_settings_apply: 'Применить',
    vbook_settings_default: 'По умолчанию',
    // Worker Settings (strings.xml ru)
    worker_settings_title_audio: 'Настройки генерации аудио',
    worker_settings_title_image: 'Настройки генерации изображений',
    worker_settings_title_video: 'Настройки генерации видео',
    worker_settings_timeout_title: 'Таймаут генерации',
    worker_settings_timeout_label: 'Таймаут {0}',
    worker_settings_timeout_desc: 'Если генерация превышает это время, задача будет автоматически отправлена повторно',
    worker_settings_timeout_unit: 'мин',
    worker_settings_apply: 'Применить',
    worker_settings_default: 'По умолчанию',
    settings_prompt_profiles: 'Профили промптов',
    settings_audio_profile: 'Аудио профиль',
    settings_image_profile: 'Профиль изображений',
    settings_video_profile: 'Видео профиль',
    settings_profiles_determined_by_workflow: 'Определяется активными workflow-коннекторами',
    workflow_manager_no_workflows: 'Нет настроенных Workflow',
    workflow_manager_manage: 'Управление',
    // Worker counts (web-дополнение)
    worker_settings_workers_title: 'Воркеры',
    worker_counts_fmt: '{0} доступно · {1} активно',
    worker_vbook: 'VBook',
    // Library
    library_open_external: 'Открыть в браузере',
    // Без открытой книги
    settings_no_book: 'Откройте книгу, чтобы настроить генерацию'
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
    toolbar_ai: 'AI',
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
    settings_language_ru: 'Russian',
    // VBook Settings (strings.xml en)
    vbook_settings_scenes_per_pass: 'Scenes per pass',
    vbook_settings_scenes_per_pass_desc: 'How many scenes the AI agent creates per generation pass (1-5). Larger values process more text per pass but take longer per window.',
    vbook_settings_apply: 'Apply',
    vbook_settings_default: 'Default',
    // Worker Settings (strings.xml en)
    worker_settings_title_audio: 'Audio Generation Settings',
    worker_settings_title_image: 'Image Generation Settings',
    worker_settings_title_video: 'Video Generation Settings',
    worker_settings_timeout_title: 'Generation Timeout',
    worker_settings_timeout_label: '{0} timeout',
    worker_settings_timeout_desc: 'If generation exceeds this time, the task will be automatically retried',
    worker_settings_timeout_unit: 'min',
    worker_settings_apply: 'Apply',
    worker_settings_default: 'Default',
    settings_prompt_profiles: 'Prompt Profiles',
    settings_audio_profile: 'Audio Profile',
    settings_image_profile: 'Image Profile',
    settings_video_profile: 'Video Profile',
    settings_profiles_determined_by_workflow: 'Determined by active workflow connectors',
    workflow_manager_no_workflows: 'No workflows configured',
    workflow_manager_manage: 'Manage',
    // Worker counts (web-only addition)
    worker_settings_workers_title: 'Workers',
    worker_counts_fmt: '{0} available · {1} active',
    worker_vbook: 'VBook',
    // Library
    library_open_external: 'Open in browser',
    // No book open
    settings_no_book: 'Open a book to configure generation'
  }
} as const;

export type StrKey = keyof typeof dict['en'];

export function currentLang(): Lang {
  return (document.documentElement.getAttribute('lang') as Lang) === 'ru' ? 'ru' : 'en';
}

export function t(key: StrKey, fallback?: string): string {
  return dict[currentLang()][key] ?? fallback ?? key;
}

// t with {0}/{1}/... positional args (Android %1$s equivalent).
export function tf(key: StrKey, ...args: (string | number)[]): string {
  let s: string = dict[currentLang()][key] ?? key;
  args.forEach((a, i) => { s = s.split(`{${i}}`).join(String(a)); });
  return s;
}
