const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (_req, res) => {
  res.json({ ok: true, version: 'parser-v6-serverreadtg' });
});

app.get('/posts', async (req, res) => {
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

    const url = `https://t.me/s/${encodeURIComponent(channel)}${before ? `?before=${encodeURIComponent(before)}` : ''}`;

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
      if (value.startsWith('/')) return `https://t.me${value}`;
      return value;
    };

    const isDirectVideoUrl = (value) => {
      const v = String(value || '').toLowerCase();
      return /(\.mp4($|\?)|\/file\/|cdn\d*\.telesco\.pe\/file\/)/i.test(v);
    };

    const fetchVideoFromEmbed = async (channelName, postId, postUrlToSkip) => {
      if (!channelName || !postId) return '';

      try {
        const embedUrl = `https://t.me/${encodeURIComponent(channelName)}/${encodeURIComponent(postId)}?embed=1`;
        const embedResp = await axios.get(embedUrl, {
          timeout: 12000,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
          },
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

    $('.tgme_widget_message_wrap').each((_, el) => {
      const msg = $(el).find('.tgme_widget_message');
      const dataPost = msg.attr('data-post') || '';
      if (!dataPost.includes('/')) return;

      const postUrl = `https://t.me/${dataPost}`;

      const idFromDataPost = (dataPost.match(/\/(\d+)(?:\?|$)/) || [])[1];
      const idFromUrl = (postUrl.match(/\/(\d+)(?:\?|$)/) || [])[1];
      const id = Number(idFromDataPost || idFromUrl || 0) || null;

      const text = $(el).find('.tgme_widget_message_text').text().trim();

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
      const playerHref = normalizeUrl($(el).find('.tgme_widget_message_video_player').attr('href') || '');
      const wrapHref = normalizeUrl($(el).find('.tgme_widget_message_video_wrap a').attr('href') || '');
      const anyMp4Href = normalizeUrl($(el).find('a[href*=".mp4"]').first().attr('href') || '');
      const anyFileHref = normalizeUrl($(el).find('a[href*="/file/"]').first().attr('href') || '');

      const videoCandidates = [sourceSrc, inlineVideoSrc, playerHref, wrapHref, anyMp4Href, anyFileHref]
        .filter(Boolean)
        .filter((v) => normalizeUrl(v) !== normalizeUrl(postUrl));

      const videoUrl = videoCandidates.find((v) => isDirectVideoUrl(v)) || '';

      const hasVideoHint =
        $(el).find('video').length > 0 ||
        $(el).find('.tgme_widget_message_video_wrap').length > 0 ||
        $(el).find('.tgme_widget_message_video_player').length > 0;

      posts.push({
        id,
        text,
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

    const output = latest.map(({ dateTs: _dateTs, has_video_hint: _hint, ...rest }) => rest);

    res.json({ channel, count: output.length, posts: output });
  } catch (err) {
    res.status(500).json({
      error: 'Failed to fetch/parse channel page',
      details: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Parser API started on http://localhost:${PORT}`);
});

