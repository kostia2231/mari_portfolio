/**
 * Главный скрипт страницы. Грузит манифест проектов из /projects.json,
 * рендерит ленту и индекс, навешивает viewer, navigation, video controls.
 *
 * Все URL'ы медиа собираются через src/lib/cdn.ts (один источник истины).
 * Источник данных — src/lib/manifest.ts (типы + fetch).
 */

import gsap from "gsap"

import {
    hiResUrl,
    lowResUrl,
    midResUrl,
    posterUrl,
    thumbHiUrl,
    videoSrcUrl,
} from "../lib/cdn"
import { loadManifest, type MediaFile, type Project } from "../lib/manifest"

/* ============================================================
   State
   ============================================================ */

type GalleryItem = MediaFile & { projectTag: string }

const projectFilesMap = new Map<string, MediaFile[]>()
const projectMetaMap = new Map<string, { services?: string }>()
const preloadedProjects = new Set<string>()
const indexPreloadUrls: string[] = []

let isAssetsLoaded = false
let isTextCycleDone = false
let isLoaderHidden = false
let rollerTimer: gsap.core.Tween | null = null

let currentProjectFiles: MediaFile[] = []
let currentViewerIndex = 0
let progressLoopId = 0
let isViewerOpen = false
let isViewerOpening = false
let isInfoOpen = false
let isIndexOpen = false

const isMobile = () => window.innerWidth < 768

/* ============================================================
   DOM helpers
   ============================================================ */

const $ = <T extends HTMLElement>(s: string): T => document.querySelector<T>(s)!
const gridOverlay = $<HTMLElement>(".grid-overlay")

/* ============================================================
   Loader / text roller
   ============================================================ */

function checkReveal() {
    if (isAssetsLoaded && isTextCycleDone && !isLoaderHidden) {
        isLoaderHidden = true
        setTimeout(hideLoader, 400)
    }
}

function initTextRoller(
    selector: string,
    words: string[],
    interval: number,
    moveDistance: number,
) {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el || words.length === 0) {
        isTextCycleDone = true
        checkReveal()
        return
    }
    if (words.length <= 1) isTextCycleDone = true

    let currentIndex = 0
    let swapCount = 0
    el.innerText = words[currentIndex]

    const swap = () => {
        if (!document.body.contains(el)) return
        gsap.timeline()
            .to(el, {
                y: -moveDistance,
                opacity: 0,
                duration: 0.5,
                ease: "power3.in",
                onComplete: () => {
                    currentIndex = (currentIndex + 1) % words.length
                    el.innerText = words[currentIndex]
                },
            })
            .set(el, { y: moveDistance })
            .to(el, {
                y: 0,
                opacity: 1,
                duration: 0.5,
                ease: "power4.out",
                onComplete: () => {
                    swapCount++
                    if (swapCount === words.length - 1) {
                        isTextCycleDone = true
                        checkReveal()
                    }
                },
            })
        rollerTimer = gsap.delayedCall(interval, swap)
    }

    rollerTimer = gsap.delayedCall(interval, swap)
}

function trackLoading() {
    // Loader % привязан ТОЛЬКО к low-res `<img>` главной ленты:
    //   - картинки галереи (initial src = lowResUrl)
    //   - персистентные постеры за видео (.world-image__poster)
    // Не считаем:
    //   - индекс-миниатюры (`.index-thumbnails img`) — их много и они
    //     скрыты до открытия Index, грузить их не блокирующее
    //   - <video> — это полные mp4, не low quality, плюс Chrome лениво
    //     грузит off-screen видео; они автозапустятся через
    //     IntersectionObserver когда попадут в viewport
    //   - thumb-hi имеют src только после ховера в индексе — не блокируют
    const images = Array.from(
        document.querySelectorAll<HTMLImageElement>(".world-image img"),
    )
    const total = images.length

    let loaded = 0
    let completed = false
    let current = 0
    const startTime = performance.now()
    const loaderText = document.getElementById("loader-text")

    /**
     * Time-based ceiling — the counter drifts continuously to here even when
     * no events fire. Without this the % freezes for 100+ms between asset
     * loads and looks janky. 85% in 5s feels natural and never overruns
     * real progress because event-based wins via Math.max when assets land.
     */
    const TIME_BASED_CEILING = 85
    const TIME_BASED_DURATION_MS = 5000

    const tick = () => {
        if (completed) return
        loaded++
        if (loaded >= total) completed = true
    }

    /** Hard fail-safe: forces 100% после таймаута, чтобы лоадер никогда
     *  не висел навечно (битый CDN, медленный коннект и т.п.). */
    const forceComplete = () => {
        completed = true
    }

    images.forEach((img) => {
        if (img.complete) tick()
        else {
            img.addEventListener("load", tick, { once: true })
            img.addEventListener("error", tick, { once: true })
        }
    })

    setTimeout(forceComplete, 6000)

    const animate = () => {
        // Where assets actually are. Cap at 99% so we don't hit 100 before
        // we know everything is settled.
        const eventProgress =
            total === 0 ? 100 : Math.min(99, (loaded / total) * 100)

        // Continuous time-based progress (linear up to TIME_BASED_CEILING).
        const elapsed = performance.now() - startTime
        const timeProgress = Math.min(
            TIME_BASED_CEILING,
            (elapsed / TIME_BASED_DURATION_MS) * TIME_BASED_CEILING,
        )

        // Monotonic target: never decreases. completed → 100 unconditionally.
        const target = completed
            ? 100
            : Math.max(eventProgress, timeProgress, current)

        // Exponential ease toward target — smooth, frame-rate friendly.
        current += (target - current) * 0.15
        if (current > 100) current = 100

        if (loaderText) loaderText.innerText = `${Math.floor(current)}%`

        if (current < 99.95) {
            requestAnimationFrame(animate)
        } else {
            current = 100
            if (loaderText) loaderText.innerText = "100%"
            isAssetsLoaded = true
            checkReveal()
        }
    }
    requestAnimationFrame(animate)
}

function hideLoader() {
    const loader = document.getElementById("loader")
    if (!loader) return

    loader.classList.add("is-hidden")
    document.querySelector(".instructions")?.classList.remove("is-hidden")
    document.querySelectorAll<HTMLElement>(".world-image").forEach((el) => {
        el.classList.add("is-revealed")
        el.addEventListener(
            "transitionend",
            () => {
                // Снимаем композитный слой целиком: убираем `will-change`,
                // `backface-visibility` И сам no-op transform translate3d(0,0,0).
                // Без этого каждая карточка остаётся на собственном GPU-слое
                // навсегда → компоситор тащит десятки слоёв при скролле.
                el.style.willChange = "auto"
                el.style.backfaceVisibility = "visible"
                el.style.transform = "none"
            },
            { once: true },
        )
    })

    if (rollerTimer) rollerTimer.kill()
    gsap.killTweensOf("#animated-text")
    setTimeout(() => loader.remove(), 600)
}

/* ============================================================
   Manifest load + entry point
   ============================================================ */

async function loadFromManifest() {
    let manifest
    try {
        manifest = await loadManifest()
    } catch (err) {
        console.error("Failed to load /projects.json:", err)
        isAssetsLoaded = true
        checkReveal()
        return
    }

    // Сортировка по position (asc). Без значения — в конец.
    // Делаем на клиенте чтобы работало даже если projects.json правили вручную.
    manifest.projects.sort((a, b) => {
        const ap = typeof a.position === "number" ? a.position : Infinity
        const bp = typeof b.position === "number" ? b.position : Infinity
        return ap - bp
    })

    // "About" project — its media goes into the About panel, not on
    // main/index. Match by tag (case-insensitive). Strip first so it's
    // invisible to all other consumers (gallery, index, preload, maps).
    const aboutIdx = manifest.projects.findIndex(
        (p) => p.tag.trim().toLowerCase() === "about",
    )
    const aboutProject =
        aboutIdx >= 0 ? manifest.projects.splice(aboutIdx, 1)[0] : null

    // Populate project files map for fast lookups (preload, click → first file).
    manifest.projects.forEach((p) => {
        projectFilesMap.set(p.tag, p.files)
        projectMetaMap.set(p.tag, { services: p.services })
    })

    // Lo-res очень лёгкий (~5 KB JPEG) — грузим для ВСЕХ файлов сразу.
    // Это даёт мгновенные миниатюры в индексе и постеры в viewer'е без
    // ожидания сети. Эконмить тут смысла нет.
    manifest.projects.forEach((p) => {
        p.files.forEach((f) => {
            const img = new Image()
            img.src = lowResUrl(f)
        })
    })

    // Main page shows only files marked `featured` (formerly `portfolio` tag).
    // If a project has no featured files, fall back to its first file as cover.
    const galleryItems: GalleryItem[] = manifest.projects.flatMap((p) => {
        const featured = p.files.filter((f) => f.featured)
        const items = featured.length > 0 ? featured : p.files.slice(0, 1)
        return items.map((f) => ({ ...f, projectTag: p.tag }))
    })

    renderAbout(aboutProject?.files ?? [])

    if (galleryItems.length === 0) {
        isAssetsLoaded = true
        checkReveal()
        return
    }

    renderGallery(galleryItems)
    renderIndex(manifest.projects)
    trackLoading()
    setupVideoVisibilityObserver()
}

/* ============================================================
   Project preload (called on main-gallery hover)
   ============================================================ */

function preloadProjectLowRes(projectTag: string) {
    if (preloadedProjects.has(projectTag)) return
    const files = projectFilesMap.get(projectTag)
    if (!files) return
    preloadedProjects.add(projectTag)

    for (const file of files) {
        if (file.type === "image") {
            const p = new Image()
            p.src = lowResUrl(file)
        }
    }
}

/* ============================================================
   Gallery (main page two-column scrolling feed)
   ============================================================ */

function renderGallery(items: GalleryItem[]) {
    const leftCol = $<HTMLElement>(".left")
    const topDescEl = $<HTMLElement>("#top-image-description")

    const addToCol = (item: GalleryItem, index: number, col: HTMLElement) => {
        const wrapper = createMediaWrapper(item, index)
        col.appendChild(wrapper)

        wrapper.addEventListener("mouseenter", () => {
            if (isViewerOpen) return
            topDescEl.textContent = item.projectTag
            topDescEl.classList.add("is-visible")
            preloadProjectLowRes(item.projectTag)
        })
        wrapper.addEventListener("mouseleave", () => {
            topDescEl.classList.remove("is-visible")
        })
        wrapper.addEventListener("click", () => {
            const target = projectFilesMap.get(item.projectTag)?.[0] ?? item
            openProjectForFile(item.projectTag, target)
        })
    }

    // Верх: все айтемы в прямом порядке. Нижний ряд убран — не рендерим.
    items.forEach((item, i) => addToCol(item, i, leftCol))
}

function createMediaWrapper(item: MediaFile, index: number): HTMLDivElement {
    const wrapper = document.createElement("div")
    wrapper.className = "world-image"
    wrapper.style.transitionDelay = `${index * 0.05}s`
    wrapper.dataset.type = item.type

    // Стабильные размеры до загрузки <img>: aspect-ratio из манифеста +
    // low-res как background. Кеш уже тёплый (см. предзагрузку выше) —
    // bg красится мгновенно, поэтому при заезде в viewport нет белой
    // вспышки и layout shift'а от появления <img>.
    if (item.w && item.h) {
        wrapper.style.aspectRatio = `${item.w} / ${item.h}`
    }
    wrapper.style.backgroundImage = `url("${lowResUrl(item)}")`
    wrapper.style.backgroundSize = "cover"
    wrapper.style.backgroundPosition = "center"

    if (item.type === "video") {
        const posterSrc = posterUrl(item)
        wrapper.innerHTML =
            `<img class="world-image__poster" src="${posterSrc}" alt="" aria-hidden="true" decoding="async">` +
            `<video src="${videoSrcUrl(item)}" poster="${posterSrc}" autoplay muted loop playsinline preload="metadata" disableremoteplayback draggable="false"></video>`
    } else {
        wrapper.innerHTML = `<img src="${lowResUrl(item)}" draggable="false" decoding="async">`
        const img = wrapper.querySelector<HTMLImageElement>("img")!

        // В галерее показываем mid (h=800px) — этого достаточно для карточек.
        // Hi-res грузит viewer по требованию. Экономия — несколько МБ на
        // длинных портфолио.
        const md = new Image()
        md.src = midResUrl(item)
        md.onload = () => {
            img.src = md.src
        }
    }
    return wrapper
}

/* ============================================================
   Video visibility / play-pause
   ============================================================ */

let videoVisibilityObserver: IntersectionObserver | null = null

function setupVideoVisibilityObserver() {
    if (videoVisibilityObserver) videoVisibilityObserver.disconnect()
    const videos = document.querySelectorAll<HTMLVideoElement>("#world video")
    if (!videos.length) return

    videoVisibilityObserver = new IntersectionObserver(
        (entries) => {
            if (isViewerOpen) return
            entries.forEach((entry) => {
                const vid = entry.target as HTMLVideoElement
                if (entry.isIntersecting) {
                    if (vid.paused) vid.play().catch(() => {})
                } else if (!vid.paused) {
                    vid.pause()
                }
            })
        },
        {
            root: null,
            rootMargin: isMobile() ? "200px 0px" : "0px 200px",
            threshold: 0,
        },
    )
    videos.forEach((v) => videoVisibilityObserver!.observe(v))
}

function playVisibleWorldVideos() {
    const vh = window.innerHeight
    document.querySelectorAll<HTMLVideoElement>("#world video").forEach((v) => {
        const r = v.getBoundingClientRect()
        if (r.bottom > 0 && r.top < vh && v.paused) {
            v.play().catch(() => {})
        }
    })
}

function pauseAllWorldVideos() {
    document
        .querySelectorAll<HTMLVideoElement>("#world video")
        .forEach((v) => v.pause())
}

/* ============================================================
   Index panel (project list overlay)
   ============================================================ */

const MAX_THUMBS = 5

function renderIndex(projects: Project[]) {
    const list = document.querySelector<HTMLUListElement>("#index-project-list")
    if (!list) return
    list.innerHTML = ""

    projects.forEach((project, idx) => {
        list.appendChild(createProjectRow(project, idx))
        // Pre-collect URLs for index-btn hover preload
        for (const file of project.files) {
            if (file.type === "image") indexPreloadUrls.push(lowResUrl(file))
        }
    })
}

function createProjectRow(project: Project, idx: number): HTMLLIElement {
    const li = document.createElement("li")
    li.className = "index-project-row"
    li.style.transitionDelay = `${idx * 0.05}s`
    const hasImage = project.files.some((f) => f.type === "image")
    const hasVideo = project.files.some((f) => f.type === "video")
    li.dataset.hasImage = hasImage ? "1" : "0"
    li.dataset.hasVideo = hasVideo ? "1" : "0"

    const count = project.files.length
    const countLine =
        count > 1 ? `<br><span class="index-count">${count} items</span>` : ""
    li.innerHTML = `
        <div class="index-text"><span class="index-num">${idx + 1}. </span>${project.tag}${countLine}</div>
        <div class="index-thumbnails"></div>
    `

    li.addEventListener("click", (e) => {
        e.stopPropagation()
        document.querySelector(".index-wrapper")?.classList.remove("is-visible")
        document.querySelector("#index-btn")?.classList.remove("is-active")
        const target = project.files[0]
        if (target) openProjectForFile(project.tag, target)
    })

    const thumbs = li.querySelector<HTMLElement>(".index-thumbnails")!
    thumbs.innerHTML = project.files
        .map((file, i) => {
            const cls = i >= MAX_THUMBS ? "thumb-extra" : ""
            return `<img class="${cls}" src="${lowResUrl(file)}" alt="" loading="lazy" decoding="async">`
        })
        .join("")

    return li
}

/* ============================================================
   Viewer (fullscreen project view)
   ============================================================ */

function openProjectForFile(projectTag: string, file: MediaFile) {
    const initial = file.type === "video" ? videoSrcUrl(file) : lowResUrl(file)
    const poster = file.type === "video" ? posterUrl(file) : null
    const files = projectFilesMap.get(projectTag) ?? []
    const idx = files.findIndex((f) => f.id === file.id)
    const startIndex = idx >= 0 ? idx : 0
    openProject(projectTag, file.type, initial, poster, startIndex)
}

async function openProject(
    projectTag: string,
    initialType: "image" | "video",
    initialUrl: string,
    poster: string | null,
    startIndex: number = 0,
) {
    isViewerOpen = true
    isViewerOpening = true
    setTimeout(() => {
        isViewerOpening = false
    }, 650)
    document.body.style.overflow = "hidden"

    const wrapper = $<HTMLElement>(".view-image-wrapper")
    const text = $<HTMLElement>(".view-image__text")
    const stage = $<HTMLElement>(".view-image")
    const controls = $<HTMLElement>(".video-controls")

    $<HTMLElement>(".project-title-ui").textContent = projectTag
    const servicesEl = document.querySelector<HTMLElement>(".project-services")
    if (servicesEl) {
        const services = projectMetaMap.get(projectTag)?.services ?? ""
        servicesEl.textContent = services
        servicesEl.style.display = services ? "" : "none"
    }

    if (initialType === "video") {
        controls.style.display = "flex"
        const posterAttr = poster ? ` poster="${poster}"` : ""
        stage.innerHTML = `<video id="viewer-main-vid" src="${initialUrl}"${posterAttr} autoplay loop muted playsinline style="width:100%; height:100%; object-fit: contain;"></video>`
    } else {
        controls.style.display = "none"
        const pre = new Image()
        pre.src = initialUrl
        try {
            await pre.decode()
        } catch {
            /* ignore */
        }
        stage.innerHTML = `<img id="viewer-main-img" src="${initialUrl}" style="width:100%; height:100%; object-fit:cover;">`
    }

    pauseAllWorldVideos()

    // Кадры проекта — берём прямо из манифеста, без сетевых запросов.
    const files = projectFilesMap.get(projectTag)
    if (files?.length) {
        currentProjectFiles = files
        currentViewerIndex = Math.min(startIndex, files.length - 1)
        buildThumbStrip()
        updateViewerFrame()
    }

    wrapper.classList.add("is-visible")
    gridOverlay.classList.add("is-visible")
    $<HTMLElement>(".viewer-prev").style.display = "block"
    $<HTMLElement>(".viewer-next").style.display = "block"

    setTimeout(() => {
        if (!isViewerOpen) return
        text.classList.add("is-visible")
        if (controls.style.display === "flex") {
            controls.classList.add("is-visible")
        }
    }, 550)

    startProgressLoop()

    setTimeout(() => {
        if (!isViewerOpen) return
        document.querySelector(".instructions")?.classList.add("is-hidden")
    }, 150)

    document.querySelector(".ui-layer__bottom")?.classList.add("is-hidden")
    document
        .querySelector("#top-image-description")
        ?.classList.remove("is-visible")

    updateViewerCursor()
}

function updateViewerCursor() {
    const prev = document.querySelector<HTMLElement>(".viewer-prev")
    const next = document.querySelector<HTMLElement>(".viewer-next")
    const wrapper = document.querySelector<HTMLElement>(".view-image-wrapper")
    if (!prev || !next || !wrapper) return

    const hasMany = currentProjectFiles.length > 1
    prev.style.cursor =
        hasMany && currentViewerIndex > 0 ? "w-resize" : "zoom-out"
    next.style.cursor =
        hasMany && currentViewerIndex < currentProjectFiles.length - 1
            ? "e-resize"
            : "zoom-out"
    wrapper.style.cursor = ""
}

/**
 * Считает целочисленные пиксельные размеры медиа под доступную область
 * стейджа (`.view-image` минус padding). Парент центрирует элемент через
 * flex — никакого `object-fit`, никаких субпиксельных размеров → нет
 * шиммера у видео при воспроизведении.
 */
function fitViewerMedia(file: MediaFile) {
    const media = (document.getElementById("viewer-main-vid") ||
        document.getElementById("viewer-main-img")) as HTMLElement | null
    if (!media || !file.w || !file.h) return

    const stage = $<HTMLElement>(".view-image")
    const cs = getComputedStyle(stage)
    const cw =
        stage.clientWidth -
        parseFloat(cs.paddingLeft) -
        parseFloat(cs.paddingRight)
    const ch =
        stage.clientHeight -
        parseFloat(cs.paddingTop) -
        parseFloat(cs.paddingBottom)
    if (cw <= 0 || ch <= 0) return

    const aspect = file.w / file.h
    let w: number
    let h: number
    if (cw / ch > aspect) {
        // ограничивает высота, по бокам пустота
        h = Math.floor(ch)
        w = Math.round(h * aspect)
    } else {
        // ограничивает ширина
        w = Math.floor(cw)
        h = Math.round(w / aspect)
    }
    media.style.width = `${w}px`
    media.style.height = `${h}px`
}

/**
 * Рендерит конкретный файл в основной стейдж вьюера. Не трогает state —
 * подходит и для постоянного переключения (через updateViewerFrame), и для
 * временного hover-превью со стрипа миниатюр.
 */
function renderViewerFile(file: MediaFile) {
    const stage = $<HTMLElement>(".view-image")
    const controls = $<HTMLElement>(".video-controls")
    const textVisible =
        $<HTMLElement>(".view-image__text").classList.contains("is-visible")

    if (file.type === "video") {
        controls.style.display = "flex"
        if (textVisible) {
            requestAnimationFrame(() => controls.classList.add("is-visible"))
        }
        const url = videoSrcUrl(file)
        const poster = posterUrl(file)
        const existingImg = document.getElementById("viewer-main-img")
        if (existingImg) existingImg.remove()
        let vid = document.getElementById(
            "viewer-main-vid",
        ) as HTMLVideoElement | null
        if (!vid) {
            stage.innerHTML = `<video id="viewer-main-vid" src="${url}" poster="${poster}" autoplay loop muted playsinline></video>`
        } else if (!vid.src.includes(file.id)) {
            vid.poster = poster
            vid.src = url
            vid.play().catch(() => {})
        }
    } else {
        controls.classList.remove("is-visible")
        controls.style.display = "none"

        const low = lowResUrl(file)
        const mid = midResUrl(file)
        const hi = hiResUrl(file)
        const existingVid = document.getElementById("viewer-main-vid")
        if (existingVid) existingVid.remove()

        // Всегда показываем lo сначала, потом апгрейдим до mid/hi. Даёт
        // консистентный feel перехода, даже если hi уже в кеше.
        let img = document.getElementById(
            "viewer-main-img",
        ) as HTMLImageElement | null
        if (!img) {
            stage.innerHTML = `<img id="viewer-main-img" src="${low}" decoding="async">`
            img = document.getElementById("viewer-main-img") as HTMLImageElement
        } else if (!img.src.includes(file.id) || !img.src.includes("-lo")) {
            img.src = low
        }

        // Удержание на lo: 300 мс при next/prev, 700 мс при открытии (чтобы
        // свап img.src не дёргался во время slide-up анимации виуйера 600ms).
        const loSetAt = performance.now()
        const MIN_LO_MS = isViewerOpening ? 700 : 300
        const delayedSwap = (cb: () => void) => {
            const elapsed = performance.now() - loSetAt
            if (elapsed >= MIN_LO_MS) cb()
            else setTimeout(cb, MIN_LO_MS - elapsed)
        }

        // Цепочка lo → mid → hi. onload ставится ДО src, иначе для cached
        // картинок load событие пропустится.
        const md = new Image()
        md.onload = () =>
            delayedSwap(() => {
                if (
                    img &&
                    img.src.includes(file.id) &&
                    img.src.includes("-lo")
                ) {
                    img.src = mid
                }
            })
        md.src = mid

        const hd = new Image()
        hd.onload = () =>
            delayedSwap(() => {
                if (img && img.src.includes(file.id)) {
                    img.src = hi
                }
            })
        hd.src = hi
    }

    fitViewerMedia(file)
}

function updateViewerFrame() {
    const file = currentProjectFiles[currentViewerIndex]
    renderViewerFile(file)
    updateThumbStripActive(currentViewerIndex)

    // Prefetch соседних кадров (картинки)
    ;[currentViewerIndex - 1, currentViewerIndex + 1].forEach((j) => {
        const f = currentProjectFiles[j]
        if (f?.type === "image") new Image().src = hiResUrl(f)
    })

    updateViewerCursor()
}

/**
 * Строит стрип миниатюр для текущего проекта. Клик переключает
 * `currentViewerIndex`, ховер — временно показывает превью без изменения
 * state; уход курсора со стрипа возвращает активный кадр.
 */
function buildThumbStrip() {
    const strip = document.querySelector<HTMLElement>(".viewer-thumbs")
    if (!strip) return

    if (currentProjectFiles.length <= 1) {
        strip.style.display = "none"
        strip.innerHTML = ""
        return
    }

    strip.style.display = ""
    strip.innerHTML = currentProjectFiles
        .map(
            (file, i) =>
                `<img class="viewer-thumb" data-idx="${i}" data-type="${file.type}" src="${lowResUrl(file)}" alt="" decoding="async">`,
        )
        .join("")

    strip.querySelectorAll<HTMLImageElement>(".viewer-thumb").forEach((el) => {
        const idx = Number(el.dataset.idx)
        el.addEventListener("click", (e) => {
            e.stopPropagation()
            if (idx === currentViewerIndex) return
            currentViewerIndex = idx
            updateViewerFrame()
        })
        if (!isMobile()) {
            el.addEventListener("mouseenter", (e) => {
                e.stopPropagation()
                if (idx === currentViewerIndex) return
                renderViewerFile(currentProjectFiles[idx])
            })
        }
    })

    updateThumbStripActive(currentViewerIndex)
}

function updateThumbStripActive(idx: number) {
    let activeEl: HTMLImageElement | null = null
    document
        .querySelectorAll<HTMLImageElement>(".viewer-thumbs .viewer-thumb")
        .forEach((el) => {
            const isActive = Number(el.dataset.idx) === idx
            el.classList.toggle("is-active", isActive)
            if (isActive) activeEl = el
        })
    // Скроллим стрип так чтобы активный thumb был видим. `nearest` =
    // минимальный сдвиг, ничего не делает если уже виден. Smooth — приятно,
    // без скачков; не блокирует клики т.к. это compositor-scroll браузера.
    if (activeEl) {
        ;(activeEl as HTMLImageElement).scrollIntoView({
            inline: "nearest",
            block: "nearest",
            behavior: "smooth",
        })
    }
}

/* ============================================================
   Video controls
   ============================================================ */

function startProgressLoop() {
    const loop = () => {
        const vid = document.getElementById(
            "viewer-main-vid",
        ) as HTMLVideoElement | null
        const bar = document.querySelector<HTMLElement>(
            ".video-controls__progress-bar",
        )
        const btnPlay = document.querySelector<HTMLElement>(
            ".video-controls__play-pause",
        )
        const btnSound = document.querySelector<HTMLElement>(
            ".video-controls__sound",
        )
        const tCur = document.querySelector<HTMLElement>(
            ".video-controls__time-current",
        )
        const tDur = document.querySelector<HTMLElement>(
            ".video-controls__time-duration",
        )

        if (vid && bar && btnPlay && btnSound) {
            if (vid.duration) {
                bar.style.width = `${(vid.currentTime / vid.duration) * 100}%`
                if (tCur && tDur) {
                    tCur.textContent = formatTime(vid.currentTime)
                    tDur.textContent = formatTime(vid.duration)
                }
            }
            btnPlay.textContent = vid.paused ? "Play" : "Pause"
            btnSound.textContent = vid.muted ? "Unmute" : "Mute"
        }
        progressLoopId = requestAnimationFrame(loop)
    }
    loop()
}

function stopProgressLoop() {
    cancelAnimationFrame(progressLoopId)
}

function formatTime(t: number): string {
    if (isNaN(t)) return "0:00"
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    return `${m}:${s.toString().padStart(2, "0")}`
}

/* ============================================================
   Sync scroll between top and bottom rows (horizontal axis)
   ============================================================ */

function initSyncScroll() {
    const lWrap = $<HTMLElement>(".left-wrapper")

    let maxL = 0
    const recompute = () => {
        maxL = Math.max(0, lWrap.scrollWidth - lWrap.clientWidth)
    }
    recompute()
    window.addEventListener("resize", recompute)
    if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(recompute)
        ro.observe(lWrap.firstElementChild ?? lWrap)
    }

    // Wheel: вертикальное колесо → горизонтальный скролл единственного ряда.
    // rAF-батчинг: коалесцируем wheel-события за кадр в один scrollLeft write.
    let pendingDelta = 0
    let wheelScheduled = false
    const flushWheel = () => {
        wheelScheduled = false
        if (pendingDelta === 0) return
        const newL = Math.max(
            0,
            Math.min(maxL, lWrap.scrollLeft + pendingDelta),
        )
        pendingDelta = 0
        lWrap.scrollLeft = newL
    }
    const worldEl = document.getElementById("world")
    ;(worldEl ?? document.documentElement).addEventListener(
        "wheel",
        (e: WheelEvent) => {
            if (isViewerOpen || isInfoOpen || isIndexOpen) return
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
            e.preventDefault()
            pendingDelta += e.deltaY
            if (!wheelScheduled) {
                wheelScheduled = true
                requestAnimationFrame(flushWheel)
            }
        },
        { passive: false },
    )
}

/* ============================================================
   Viewer close + navigation
   ============================================================ */

function initViewerControls() {
    const viewImageWrapper = $<HTMLElement>(".view-image-wrapper")
    const viewImage = $<HTMLElement>(".view-image")
    const viewImageText = $<HTMLElement>(".view-image__text")
    const videoControls = $<HTMLElement>(".video-controls")
    const closeBtn = document.querySelector(".view-image__text__close")
    const thumbStrip = document.querySelector<HTMLElement>(".viewer-thumbs")

    closeBtn?.addEventListener("click", (e) => {
        e.stopPropagation()
        viewImageWrapper.click()
    })

    // Уход курсора со стрипа возвращает кадр на активный индекс
    // (отменяет hover-превью). Bind один раз — иначе при каждом
    // buildThumbStrip накапливались бы дубликаты.
    if (!isMobile()) {
        thumbStrip?.addEventListener("mouseleave", () => {
            const file = currentProjectFiles[currentViewerIndex]
            if (file) renderViewerFile(file)
        })
    }

    viewImageWrapper.addEventListener("click", () => {
        isViewerOpen = false
        document.body.style.overflow = ""
        document
            .querySelector("#top-image-description")
            ?.classList.remove("is-visible")
        document.querySelector(".instructions")?.classList.remove("is-hidden")
        document
            .querySelector(".ui-layer__bottom")
            ?.classList.remove("is-hidden")
        viewImageText.classList.remove("is-visible")
        viewImageWrapper.classList.remove("is-visible")
        videoControls.classList.remove("is-visible")
        gridOverlay.classList.remove("is-visible")
        $<HTMLElement>(".viewer-prev").style.display = "none"
        $<HTMLElement>(".viewer-next").style.display = "none"

        stopProgressLoop()
        playVisibleWorldVideos()

        setTimeout(() => {
            if (viewImageWrapper.classList.contains("is-visible")) return
            viewImage.innerHTML = ""
            videoControls.style.display = "none"
            const progressBar = document.querySelector<HTMLElement>(
                ".video-controls__progress-bar",
            )
            if (progressBar) progressBar.style.width = "0%"
        }, 600)
    })

    const prevArea = $<HTMLElement>(".viewer-prev")
    const nextArea = $<HTMLElement>(".viewer-next")

    prevArea.addEventListener("click", (e) => {
        e.stopPropagation()
        if (currentViewerIndex > 0) {
            currentViewerIndex--
            updateViewerFrame()
        } else {
            viewImageWrapper.click()
        }
    })

    nextArea.addEventListener("click", (e) => {
        e.stopPropagation()
        if (currentViewerIndex < currentProjectFiles.length - 1) {
            currentViewerIndex++
            updateViewerFrame()
        } else {
            viewImageWrapper.click()
        }
    })

    prevArea.addEventListener("mouseenter", updateViewerCursor)
    nextArea.addEventListener("mouseenter", updateViewerCursor)
}

function initVideoControlsButtons() {
    const videoControls = $<HTMLElement>(".video-controls")
    const btnPlay = $<HTMLElement>(".video-controls__play-pause")
    const btnSound = $<HTMLElement>(".video-controls__sound")
    const progressWrap = $<HTMLElement>(".video-controls__progress")

    videoControls.addEventListener("click", (e) => e.stopPropagation())

    btnPlay.addEventListener("click", () => {
        const vid = document.getElementById(
            "viewer-main-vid",
        ) as HTMLVideoElement | null
        if (!vid) return
        if (vid.paused) vid.play()
        else vid.pause()
    })

    btnSound.addEventListener("click", () => {
        const vid = document.getElementById(
            "viewer-main-vid",
        ) as HTMLVideoElement | null
        if (!vid) return
        vid.muted = !vid.muted
    })

    progressWrap.addEventListener("click", (e) => {
        const vid = document.getElementById(
            "viewer-main-vid",
        ) as HTMLVideoElement | null
        if (!vid) return
        const rect = progressWrap.getBoundingClientRect()
        const pos = (e.clientX - rect.left) / rect.width
        vid.currentTime = pos * vid.duration
    })
}

/* ============================================================
   About panel (canvas radial gradient + open/close)
   ============================================================ */

function renderAbout(files: MediaFile[]) {
    const info = document.getElementById("information")
    if (!info) return
    const images = files.filter((f) => f.type === "image")

    // One tile per image (min 6 placeholders if no images yet).
    // Parallax depth grows with index — deeper tiles drift faster.
    const MIN_TILES = 6
    const PARALLAX_BASE = 0.15
    const PARALLAX_STEP = 0.05
    const PARALLAX_MAX = 0.6
    const tileCount = Math.max(MIN_TILES, images.length)

    const container = document.createElement("div")
    container.className = "about-images"

    for (let i = 0; i < tileCount; i++) {
        const tile = document.createElement("div")
        tile.className = "about-tile"
        const depth = Math.min(PARALLAX_MAX, PARALLAX_BASE + i * PARALLAX_STEP)
        tile.dataset.parallax = String(depth)

        const file = images[i]
        if (file) {
            const img = document.createElement("img")
            img.src = midResUrl(file)
            img.loading = "lazy"
            img.decoding = "async"
            tile.appendChild(img)
        }
        container.appendChild(tile)
    }

    info.insertBefore(container, info.firstChild)

    const tiles = Array.from(
        container.querySelectorAll<HTMLElement>(".about-tile"),
    )

    const update = () => {
        const scrollTop = info.scrollTop
        const FADE_BAND = 200 // px from viewport top where tile shrinks to 0
        for (const tile of tiles) {
            const f = parseFloat(tile.dataset.parallax || "0.2")
            const ty = -scrollTop * f
            const tileCenter =
                tile.offsetTop - scrollTop + tile.offsetHeight / 2 + ty
            // tile full size while well below top; shrinks to 0 as its
            // center approaches viewport top
            const scale = Math.min(1, Math.max(0, tileCenter / FADE_BAND))
            tile.style.transform = `translate3d(0, ${ty}px, 0) scale(${scale})`
        }
    }

    let ticking = false
    const onScroll = () => {
        if (ticking) return
        ticking = true
        requestAnimationFrame(() => {
            update()
            ticking = false
        })
    }
    info.addEventListener("scroll", onScroll, { passive: true })
    // initial pass so tiles get correct scale before any scroll
    requestAnimationFrame(update)
}

function initAbout() {
    const infoCanvas = document.getElementById(
        "info-background",
    ) as HTMLCanvasElement
    const ictx = infoCanvas.getContext("2d")!
    const infoBtn = $<HTMLElement>("#information-btn")
    const infoBlock = $<HTMLElement>("#information")
    const infoWrap = $<HTMLElement>(".information-wrapper")

    const drawGradient = () => {
        const cx = infoCanvas.width / 2
        const cy = infoCanvas.height / 2
        const radius = Math.max(infoCanvas.width, infoCanvas.height)
        const grad = ictx.createRadialGradient(cx, cy, 0, cx, cy, radius)
        grad.addColorStop(0, "#F61D3D")
        grad.addColorStop(1, "#F61D3D")
        ictx.fillStyle = grad
        ictx.fillRect(0, 0, infoCanvas.width, infoCanvas.height)
    }

    const resizeCanvas = () => {
        infoCanvas.width = window.innerWidth
        infoCanvas.height = window.innerHeight
        drawGradient()
    }

    window.addEventListener("resize", resizeCanvas)
    infoBtn.addEventListener("click", resizeCanvas)

    infoBlock.onclick = () => {
        infoWrap.classList.remove("is-visible")
        isInfoOpen = false
    }
    infoBtn.onclick = () => {
        infoBlock.scrollTop = 0
        infoWrap.classList.add("is-visible")
        isInfoOpen = true
    }
}

/* ============================================================
   Index button (toggle index panel, preload on hover)
   ============================================================ */

function initIndexButton() {
    const btn = document.querySelector<HTMLElement>("#index-btn")
    const wrap = document.querySelector<HTMLElement>(".index-wrapper")
    if (!btn || !wrap) return

    btn.addEventListener(
        "mouseenter",
        () => {
            indexPreloadUrls.forEach((url) => {
                const p = new Image()
                p.src = url
            })
        },
        { once: true },
    )

    btn.addEventListener("click", () => {
        const isOpen = wrap.classList.contains("is-visible")
        if (isOpen) {
            isIndexOpen = false
            wrap.classList.remove("is-visible")
            btn.classList.remove("is-active")
            gridOverlay.classList.remove("is-visible")
            playVisibleWorldVideos()
        } else {
            isIndexOpen = true
            wrap.scrollTop = 0
            wrap.classList.add("is-visible")
            btn.classList.add("is-active")
            gridOverlay.classList.add("is-visible")
            pauseAllWorldVideos()
            wrap.querySelectorAll<HTMLImageElement>(
                "img[loading='lazy']",
            ).forEach((img) => {
                img.loading = "eager"
            })
        }
    })

    wrap.addEventListener("click", () => {
        isIndexOpen = false
        wrap.classList.remove("is-visible")
        btn.classList.remove("is-active")
        gridOverlay.classList.remove("is-visible")
        playVisibleWorldVideos()
    })
}

/* ============================================================
   Filter buttons (Photography / Video)
   ============================================================ */

function initFilters() {
    const photoBtn = document.querySelector<HTMLElement>("#filter-photo")
    const videoBtn = document.querySelector<HTMLElement>("#filter-video")
    if (!photoBtn || !videoBtn) return

    let current: "image" | "video" | null = null

    const apply = (type: "image" | "video") => {
        current = current === type ? null : type
        photoBtn.classList.toggle("is-active", current === "image")
        videoBtn.classList.toggle("is-active", current === "video")

        document.querySelectorAll<HTMLElement>(".world-image").forEach((el) => {
            const show = !current || el.dataset.type === current
            el.classList.toggle("is-filtered-out", !show)
        })

        document
            .querySelectorAll<HTMLElement>(".index-project-row")
            .forEach((el) => {
                const show =
                    !current ||
                    (current === "image" && el.dataset.hasImage === "1") ||
                    (current === "video" && el.dataset.hasVideo === "1")
                el.classList.toggle("is-filtered-out", !show)
            })

        const lWrap = document.querySelector<HTMLElement>(".left-wrapper")
        if (lWrap) {
            lWrap.scrollLeft = 0
            lWrap.scrollTop = 0
        }
        const idxWrap = document.querySelector<HTMLElement>(".index-wrapper")
        if (idxWrap) idxWrap.scrollTop = 0
        window.scrollTo(0, 0)
    }

    photoBtn.addEventListener("click", () => apply("image"))
    videoBtn.addEventListener("click", () => apply("video"))
}

/* ============================================================
   Boot
   ============================================================ */

window.addEventListener("resize", () => {
    if (isViewerOpen) {
        const file = currentProjectFiles[currentViewerIndex]
        if (file) fitViewerMedia(file)
    }
})

initTextRoller(
    "#animated-text",
    ["Mariia Kvasnevska", "Creative Producer", "Stylist", "Art Director"],
    1,
    40,
)

if (!isMobile()) initSyncScroll()
initViewerControls()
initVideoControlsButtons()
initAbout()
initIndexButton()
initFilters()

void loadFromManifest()
