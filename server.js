const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const PARSER_TOKEN = (process.env.PARSER_TOKEN || '').trim();
const VERSION = 'parser-v9-rich-links';

// Optional shared-secret guard. If PARSER_TOKEN env var is set, every request to /posts
// must pass the same value either via the X-Parser-Token header or ?token= query param.
// /health is intentionally always open so Render's health-check probe keeps working.
function requireToken(req, res, next) {
  if (!PARSER_TOKEN) return next();
  const header = req.get('X-Parser-Token') || '';
  const query = String(req.query.token || '');
  if (header === PARSER_TOKEN || query === PARSER_TOKEN) return next();
  return res.status(401).json({ error: 'Unauthorized: invalid or missing parser token' });
}

// ---------------------------------------------------------------------------
// Rich-text extractor — walks cheerio DOM of .tgme_widget_message_text and
// returns plain text (with links inlined), HTML (with <a>/<b>/<i>/<code>),
// and a deduplicated links array.  No heavy deps, no external packages.
// ---------------------------------------------------------------------------
function parseRichText(textEl) {
  if (!textEl || !textEl.length) {
    return { text: '', text_plain: '', text_html: '', links: [] };
  }

  const links = [];
  const seenUrls = new Set();

  const norm = (raw) => {
    const v = String(raw || '').trim();
    if (!v) return '';
    if (v.startsWith('//')) return 'https:' + v;
    if (v.startsWith('/')) return 'https://telegram.me' + v;
    return v;
  };

  const classify = (url) =>
    /t\.me|telegram\.me/i.test(url) ? 'telegram' : 'external';

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function walkNode(node) {
    if (node.type === 'text') {
      const t = node.data || '';
      return { text: t, html: esc(t) };
    }
    if (node.type !== 'tag') return { text: '', html: '' };

    const tag = (node.name || '').toLowerCase();
    if (tag === 'br') return { text: '\n', html: '\n' };

    const inner = walkChildren(node.children || []);

    if (tag === 'a') {
      const href = norm((node.attribs && node.attribs.href) || '');
      const linkText = inner.text.trim();
      if (href) {
        if (!seenUrls.has(href)) {
          seenUrls.add(href);
          links.push({ text: linkText, url: href, type: classify(href) });
        }
        // Inline format: "Label (url)" or bare "url" when label == url or empty
        const plain =
          linkText && linkText !== href
            ? `${linkText} (${href})`
            : href;
        const htmlInner = inner.html || esc(href);
        return { text: plain, html: `<a href="${href}">${htmlInner}</a>` };
      }
      return { text: inner.text, html: inner.html };
    }

    if (tag === 'b' || tag === 'strong')
      return { text: inner.text, html: `<b>${inner.html}</b>` };
    if (tag === 'i' || tag === 'em')
      return { text: inner.text, html: `<i>${inner.html}</i>` };
    if (tag === 'code')
      return { text: inner.text, html: `<code>${inner.html}</code>` };
    if (tag === 'pre')
      return { text: inner.text, html: `<pre><code>${inner.html}</code></pre>` };
    if (tag === 'p' || tag === 'blockquote')
      return { text: inner.text + '\n\n', html: inner.html + '\n\n' };

    return { text: inner.text, html: inner.html };
  }

  function walkChildren(children) {
    let text = '', html = '';
    for (const child of children) {
      const r = walkNode(child);
      text += r.text;
      html += r.html;
    }
    return { text, html };
  }

  const domNode = textEl[0];
  const { text: rawText, html: rawHtml } = walkChildren(domNode.children || []);

  const clean = (s) => s.replace(/\n{3,}/g, '\n\n').trim();

  return {
    text: clean(rawText),
    text_plain: clean(rawText),
    text_html: clean(rawHtml),
    links,
  };
}

// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ ok: true, version: VERSION, tokenProtected: Boolean(PARSER_TOKEN) });
});

app.get('/posts', requireToken, async (req, res) => {
  try {
    const rawChannel = String(req.query.channel || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const before = String(req.query.before || '').trim();

    if (!rawChannel) {
      return res.status(400).json({ error: 'Query param "channel" is required' });
    }

    const channel = rawChannel
      .replace(/^https?:\/\/t\.me\//i, '')
      .replace(/^@/, '')
      .replace(/^s\//, '')
      .split('/')[0]
      .trim();

    if (!channel) {
      return res.status(400).json({ error: 'Invalid channel value' });
    }

    const url = `https://telegram.me/s/${encodeURIComponent(channel)}${
      before ? `?before=${encodeURIComponent(before)}` : ''
    }`;

    const response = await axios.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
      },
    });

    const $ = cheerio.load(response.data);
    const posts = [];

    const normalizeUrl = (raw) => {
      const value = String(raw || '').trim();
      if (!value) return '';
      if (value.startsWith('//')) return `https:${value}`;
      if (value.startsWith('/')) return `https://telegram.me${value}`;
      return value;
    };

    const isDirectVideoUrl = (value) => {
      const v = String(value || '').toLowerCase();
      return /(\.mp4($|\?)|\/file\/|cdn\d*\.telesco\.pe\/file\/)/i.test(v);
    };

    const embedHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
    };

    const fetchVideoFromEmbed = async (channelName, postId, postUrlToSkip) => {
      if (!channelName || !postId) return '';

      try {
        const embedUrl = `https://telegram.me/${encodeURIComponent(channelName)}/${encodeURIComponent(
          postId
        )}?embed=1`;
        const embedResp = await axios.get(embedUrl, {
          timeout: 12000,
          headers: embedHeaders,
        });

        const $$ = cheerio.load(embedResp.data);
        const candidates = [
          normalizeUrl($$('meta[property="og:video"]').attr('content') || ''),
          normalizeUrl($$('meta[name="twitter:player:stream"]').attr('content') || ''),
          normalizeUrl($$('video source').attr('src') || ''),
          normalizeUrl($$('video').attr('src') || ''),
          normalizeUrl($$('a[href*=".mp4"]').first().attr('href') || ''),
          normalizeUrl($$('a[href*="/file/"]').first().attr('href') || ''),
        ]
          .filter(Boolean)
          .filter((v) => normalizeUrl(v) !== normalizeUrl(postUrlToSkip));

        return candidates.find((v) => isDirectVideoUrl(v)) || '';
      } catch (_e) {
        return '';
      }
    };

    /** Preview image for video posts (og:image on embed) — usable as sendPhoto when MP4 URL fails for bots. */
    const fetchVideoThumbFromEmbed = async (channelName, postId) => {
      if (!channelName || !postId) return '';
      try {
        const embedUrl = `https://telegram.me/${encodeURIComponent(channelName)}/${encodeURIComponent(
          postId
        )}?embed=1`;
        const embedResp = await axios.get(embedUrl, {
          timeout: 12000,
          headers: embedHeaders,
        });
        const $$ = cheerio.load(embedResp.data);
        const og = normalizeUrl($$('meta[property="og:image"]').attr('content') || '');
        return og || '';
      } catch (_e) {
        return '';
      }
    };

    $('.tgme_widget_message_wrap').each((_, el) => {
      const msg = $(el).find('.tgme_widget_message');
      const dataPost = msg.attr('data-post') || '';
      if (!dataPost.includes('/')) return;

      const postUrl = `https://telegram.me/${dataPost}`;

      const idFromDataPost = (dataPost.match(/\/(\d+)(?:\?|$)/) || [])[1];
      const idFromUrl = (postUrl.match(/\/(\d+)(?:\?|$)/) || [])[1];
      const id = Number(idFromDataPost || idFromUrl || 0) || null;

      const rich = parseRichText($(el).find('.tgme_widget_message_text').first());

      const viewsRaw = $(el).find('.tgme_widget_message_views').first().text().trim();
      const views = Number((viewsRaw || '0').replace(/[^\d]/g, '')) || 0;

      const datetime = $(el).find('time').attr('datetime') || '';
      const date = datetime || null;
      const dateTs = Date.parse(datetime || '') || 0;

      let photoUrl = '';
      const photoWrap = $(el).find('.tgme_widget_message_photo_wrap').first();
      const style = photoWrap.attr('style') || '';
      const photoMatch = style.match(/url\('([^']+)'\)/);
      if (photoMatch && photoMatch[1]) photoUrl = photoMatch[1];

      const sourceSrc = normalizeUrl($(el).find('video source').attr('src') || '');
      const inlineVideoSrc = normalizeUrl($(el).find('video').attr('src') || '');
      const playerHref = normalizeUrl(
        $(el).find('.tgme_widget_message_video_player').attr('href') || ''
      );
      const wrapHref = normalizeUrl(
        $(el).find('.tgme_widget_message_video_wrap a').attr('href') || ''
      );
      const anyMp4Href = normalizeUrl($(el).find('a[href*=".mp4"]').first().attr('href') || '');
      const anyFileHref = normalizeUrl($(el).find('a[href*="/file/"]').first().attr('href') || '');

      const videoCandidates = [
        sourceSrc,
        inlineVideoSrc,
        playerHref,
        wrapHref,
        anyMp4Href,
        anyFileHref,
      ]
        .filter(Boolean)
        .filter((v) => normalizeUrl(v) !== normalizeUrl(postUrl));

      const videoUrl = videoCandidates.find((v) => isDirectVideoUrl(v)) || '';

      const hasVideoHint =
        $(el).find('video').length > 0 ||
        $(el).find('.tgme_widget_message_video_wrap').length > 0 ||
        $(el).find('.tgme_widget_message_video_player').length > 0;

      posts.push({
        id,
        text: rich.text,
        text_plain: rich.text_plain,
        text_html: rich.text_html,
        links: rich.links,
        views,
        date,
        dateTs,
        author: channel,
        photo_url: photoUrl || '',
        video_url: videoUrl || '',
        post_url: postUrl,
        has_video_hint: hasVideoHint,
      });
    });

    const sorted = posts.sort((a, b) => {
      if ((b.id || 0) !== (a.id || 0)) return (b.id || 0) - (a.id || 0);
      return (b.dateTs || 0) - (a.dateTs || 0);
    });

    const latest = sorted.slice(0, limit);

    for (const post of latest) {
      if (!post.video_url && post.has_video_hint) {
        post.video_url = await fetchVideoFromEmbed(channel, post.id, post.post_url);
      }
    }

    for (const post of latest) {
      const needsThumb =
        (post.video_url || post.has_video_hint) && !String(post.photo_url || '').trim();
      if (needsThumb) {
        const thumb = await fetchVideoThumbFromEmbed(channel, post.id);
        if (thumb) post.photo_url = thumb;
      }
    }

    const enriched = latest.map(({ dateTs: _dateTs, has_video_hint: _hint, ...rest }) => {
      const mediaType = rest.video_url ? 'video' : rest.photo_url ? 'photo' : 'none';
      const postUid = `${channel}_${rest.id}`;
      return { ...rest, media_type: mediaType, post_uid: postUid };
    });

    res.json({ channel, count: enriched.length, posts: enriched });
  } catch (err) {
    res.status(500).json({
      error: 'Failed to fetch/parse channel page',
      details: err.message,
    });
  }
});

function escapeHtmlAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '')
    .replace(/>/g, '');
}

app.get('/tg-preview', (req, res) => {
  const img = String(req.query.img || '').trim();
  const titleRaw = String(req.query.title || 'Media preview').trim();
  const uid = String(req.query.uid || '').trim();
  const v = String(req.query.v || '').trim();

  if (!img) {
    return res
      .status(400)
      .type('text/plain; charset=utf-8')
      .send('Missing img');
  }

  if (!/^https?:\/\//i.test(img)) {
    return res
      .status(400)
      .type('text/plain; charset=utf-8')
      .send('Invalid img URL');
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  const title = escapeHtml(titleRaw.slice(0, 120) || 'Media preview');
  const image = escapeHtml(img);

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const currentUrl = `${proto}://${host}${req.originalUrl || req.url}`;

  const pageUrl = escapeHtml(currentUrl);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  // Telegram кеширует preview.
  // Поэтому в URL из n8n обязательно должен быть уникальный uid/v для каждого поста.
  res.setHeader('Cache-Control', 'public, max-age=300, no-transform');

  res.send(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <title>${title}</title>

  <meta property="og:type" content="article">
  <meta property="og:url" content="${pageUrl}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${title}">
  <meta property="og:image" content="${image}">
  <meta property="og:image:secure_url" content="${image}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${title}">
  <meta name="twitter:image" content="${image}">

  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      font-family: Arial, sans-serif;
    }

    img {
      display: block;
      width: 100%;
      max-width: 1200px;
      height: auto;
      margin: 0 auto;
    }
  </style>
</head>
<body>
  <img src="${image}" alt="${title}">
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`[${VERSION}] listening on http://localhost:${PORT}`);
  if (PARSER_TOKEN) console.log('PARSER_TOKEN guard enabled.');
});
