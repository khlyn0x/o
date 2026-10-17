import express from 'express'
import axios from 'axios'
import dns from 'node:dns/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const URL_RE = /https?:\/\/[^\s<>"']+/i

// ───────────── المكتبة (نفس كود البوت) ─────────────
let _lib = null
async function getLib() {
    if (_lib) return _lib
    const mod = await import('rahad-all-downloader-v2')
    _lib = mod.alldl || mod.default?.alldl || mod.default
    if (typeof _lib !== 'function') throw new Error('مكتبة التحميل غير متوفرة — نفّذ: npm install rahad-all-downloader-v2')
    return _lib
}

function extractUrl(s) {
    if (!s) return null
    const m = String(s).match(URL_RE)
    return m ? m[0] : null
}

function normalizeUrl(url) {
    if (!url) return url
    if (/instagram\.com|instagr\.am/i.test(url)) {
        const m = url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/)
        if (m) return `https://www.instagram.com/reel/${m[1]}/`
    }
    return url
}

function candidates(res) {
    const data = res?.data || res || {}
    const list = []
    const push = (u, hint) => {
        if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return
        if (list.some(x => x.url === u)) return
        list.push({ url: u, hint: hint || null })
    }
    const dl = data.download
    if (dl && typeof dl === 'object') {
        push(dl.url || dl.best || dl.no_watermark || dl.hd || dl.sd || dl.video || dl.audio, dl.type)
    } else if (typeof dl === 'string') {
        push(dl, null)
    }
    push(data.videoUrl, data.download?.type)
    push(data.video, null)
    push(data.url, null)
    push(data.imageUrl, 'image')
    push(data.image, 'image')
    for (const key of ['medias', 'media', 'videos', 'images', 'photos', 'urls', 'result']) {
        const arr = data[key]
        if (!Array.isArray(arr)) continue
        for (const it of arr) {
            if (typeof it === 'string') push(it, key === 'images' || key === 'photos' ? 'image' : null)
            else if (it && typeof it === 'object') push(it.url || it.videoUrl || it.image, it.type || (key === 'images' || key === 'photos' ? 'image' : null))
        }
    }
    return list
}

function guessKind(item) {
    const h = String(item.hint || '').toLowerCase()
    if (h.includes('image') || h.includes('photo')) return 'image'
    if (h.includes('audio') || h.includes('music')) return 'audio'
    if (h.includes('video')) return 'video'
    if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(item.url)) return 'image'
    if (/\.(mp3|m4a|aac|opus|ogg|wav)(\?|$)/i.test(item.url)) return 'audio'
    return 'video'
}

// ───────────── حماية SSRF ─────────────
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number)
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    }
    if (net.isIPv6(ip)) {
        const l = ip.toLowerCase()
        return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:')
    }
    return true
}

async function assertPublicUrl(u) {
    let parsed
    try { parsed = new URL(u) } catch { throw new Error('رابط غير صالح') }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('بروتوكول غير مسموح')
    const host = parsed.hostname
    if (net.isIP(host)) {
        if (isPrivateIp(host)) throw new Error('عنوان غير مسموح')
        return parsed
    }
    const addrs = await dns.lookup(host, { all: true })
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('عنوان غير مسموح')
    return parsed
}

// ───────────── Rate limit بسيط ─────────────
const hits = new Map()
function rateLimit(max, windowMs) {
    return (req, res, next) => {
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress
        const now = Date.now()
        const rec = (hits.get(ip) || []).filter(t => now - t < windowMs)
        if (rec.length >= max) return res.status(429).json({ ok: false, error: 'طلبات كتير — استنى شوية وجرّب تاني' })
        rec.push(now)
        hits.set(ip, rec)
        next()
    }
}
setInterval(() => {
    const now = Date.now()
    for (const [ip, arr] of hits) {
        const f = arr.filter(t => now - t < 600000)
        f.length ? hits.set(ip, f) : hits.delete(ip)
    }
}, 300000).unref()

// ───────────── السيرفر ─────────────
const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '10kb' }))

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')))

app.post('/api/info', rateLimit(20, 60_000), async (req, res) => {
    try {
        const raw = extractUrl(req.body?.url)
        const url = normalizeUrl(raw)
        if (!url) return res.status(400).json({ ok: false, error: 'ابعت رابط صحيح' })

        const alldl = await getLib()
        const result = await alldl(url)
        const data = result?.data || result || {}
        const list = candidates(result)
        if (!list.length) throw new Error('مفيش وسائط قابلة للتحميل من الرابط ده')

        const title = data.title && !/social media video/i.test(data.title) ? String(data.title).slice(0, 140) : 'تم العثور على الوسائط'
        const thumb = [data.thumbnail, data.thumb, data.cover, data.image, data.imageUrl]
            .find(t => typeof t === 'string' && /^https?:\/\//i.test(t)) || null

        const items = list.slice(0, 12).map((it, i) => ({
            url: it.url,
            kind: guessKind(it),
            index: i + 1
        }))
        res.json({ ok: true, title, thumbnail: thumb, author: data.author || data.username || null, items })
    } catch (e) {
        console.error('[info]', e.message)
        res.status(500).json({ ok: false, error: e.message || 'فشل جلب الرابط' })
    }
})

// بروكسي التحميل (يتخطى CORS و Referer)
app.get('/api/download', rateLimit(60, 60_000), async (req, res) => {
    try {
        const target = String(req.query.u || '')
        const inline = req.query.inline === '1'
        await assertPublicUrl(target)

        const upstream = await axios.get(target, {
            responseType: 'stream',
            timeout: 60_000,
            maxRedirects: 5,
            headers: {
                'User-Agent': UA,
                'Accept': '*/*',
                ...(req.headers.range ? { Range: req.headers.range } : {}),
                ...(inline ? {} : { Referer: 'https://www.instagram.com/' })
            },
            validateStatus: () => true
        })
        if (upstream.status >= 400) {
            upstream.data.destroy()
            return res.status(502).send('تعذّر جلب الملف من المصدر')
        }

        const ct = String(upstream.headers['content-type'] || 'application/octet-stream')
        const extMap = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }
        const ext = extMap[ct.split(';')[0].trim()] || 'bin'
        const base = String(req.query.n || 'download').replace(/[^\w\u0600-\u06FF-]+/g, '_').slice(0, 60) || 'download'

        res.status(upstream.status === 206 ? 206 : 200)
        res.setHeader('Content-Type', ct)
        for (const h of ['content-length', 'content-range', 'accept-ranges']) {
            if (upstream.headers[h]) res.setHeader(h, upstream.headers[h])
        }
        if (!inline) {
            res.setHeader('Content-Disposition', `attachment; filename="${base}.${ext}"; filename*=UTF-8''${encodeURIComponent(base)}.${ext}`)
        }
        res.setHeader('Cache-Control', 'private, max-age=300')
        upstream.data.pipe(res)
        req.on('close', () => upstream.data.destroy())
    } catch (e) {
        console.error('[download]', e.message)
        if (!res.headersSent) res.status(400).send(e.message || 'فشل التحميل')
    }
})

app.listen(PORT, () => console.log(`🚀 الموقع شغال على http://localhost:${PORT}`))
