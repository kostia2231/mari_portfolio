# Mariia Kvasnevska — портфолио

Astro 5 + Svelte 5 + GSAP. Медиа хранится в Cloudflare R2, манифест
`public/projects.json` собирается локальным скриптом перед деплоем.

## Структура медиа

Положи файлы в `v2/media/` по такой схеме:

```
v2/media/
├── Birthday/                ← название проекта (= тег в индексе)
│   ├── main/                ← файлы для главной страницы (featured)
│   │   └── cover.jpg
│   ├── 01.jpg               ← обычные файлы — только в индексе/вьюере
│   ├── 02.jpg
│   ├── 03.jpg
│   └── intro.mp4
├── HFBK PROM 2022/
│   ├── main/
│   │   └── hero.jpg
│   └── ...
└── ...
```

**Правила:**
- Имя папки = имя проекта (показывается в индексе). Можно с пробелами.
- В `main/` подпапке — файлы, попадающие на главную ленту.
- Все остальные файлы папки проекта — видны только в индексе и вьюере.
- Поддержка форматов:
  - **Фото**: `.jpg .jpeg .png .webp`
  - **Видео**: `.mp4 .mov .m4v`

## Залить медиа в R2

```bash
cd v2
cp .env.example .env
# → заполни значения R2_* и PUBLIC_R2_BASE
npm install
npm run upload
```

Скрипт:
1. Сгенерит варианты `-lo.jpg`, `-mid.jpg` и hi-res `.jpg` для каждого фото через `sharp`.
2. Перекодирует каждое видео в H.264 mp4 (h_720, fps_30, faststart) + извлечёт постер JPG через `ffmpeg`.
3. Зальёт всё в R2 под путями `projects/{slug}/...`.
4. Перезапишет `public/projects.json` отражая текущее состояние.

Уже залитые файлы пропускаются (HEAD-проверка), повторный запуск дешёвый и идемпотентный.

## Локальный dev-сервер

```bash
npm run dev
```

Откроется на `http://localhost:4321`. Использует `public/projects.json` напрямую.

## Деплой

Подключить репо к Cloudflare Pages, билд-команда `npm run build`, output `dist/`. При push на main — автоматический деплой.

## Структура проекта

```
v2/
├── .env.example              # шаблон R2 кредов и PUBLIC_R2_BASE
├── package.json              # npm run dev / build / upload
├── public/
│   ├── font/                 # шрифты
│   └── projects.json         # манифест (генерится `npm run upload`)
├── scripts/                  # build-time only, не уходит в браузер
│   ├── lib/
│   │   ├── r2-client.mjs     # S3 SDK обёртка для R2
│   │   ├── sharp-variants.mjs# генератор lo/mid/hi JPEG
│   │   └── ffmpeg-video.mjs  # H.264 транскод + постер
│   └── upload.mjs            # main скрипт заливки
└── src/
    ├── lib/
    │   ├── cdn.ts            # URL-билдеры для R2
    │   └── manifest.ts       # типы Project/MediaFile + loadManifest()
    ├── pages/
    │   └── index.astro       # разметка страницы (одна точка входа)
    └── scripts/
        └── main.ts           # runtime: лоадер, галерея, индекс, вьюер
```
