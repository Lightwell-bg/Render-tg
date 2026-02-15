const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (_req, res) => {
  res.json({ ok: true });
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
        'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8'
      }
    });

    const $ = cheerio.load(response.data);
    const posts = [];

    $('.tgme_widget_message_wrap').each((_, el) => {
      const msg = $(el).find('.tgme_widget_message');
      const dataPost = msg.attr('data-post') || '';
      if (!dataPost.includes('/')) return;

      const id = Number(dataPost.split('/')[1]) || null;
      const postUrl = `https://t.me/${dataPost}`;

      const text = $(el).find('.tgme_widget_message_text').text().trim();
      const viewsRaw = $(el).find('.tgme_widget_message_views').first().text().trim();
      const views = Number((viewsRaw || '0').replace(/[^\d]/g, '')) || 0;

      const datetime = $(el).find('time').attr('datetime') || '';
      const date = datetime || null;

      let photoUrl = '';
      const photoWrap = $(el).find('.tgme_widget_message_photo_wrap').first();
      const style = photoWrap.attr('style') || '';
      const m = style.match(/url\('([^']+)'\)/);
      if (m && m[1]) photoUrl = m[1];

      let videoUrl = '';
      const videoSrc = $(el).find('video source').attr('src') || $(el).find('video').attr('src') || '';
      if (videoSrc) {
        videoUrl = videoSrc.startsWith('//') ? `https:${videoSrc}` : videoSrc;
      }

      posts.push({
        id,
        text,
        views,
        date,
        author: channel,
        photo_url: photoUrl || '',
        video_url: videoUrl || '',
        post_url: postUrl
      });
    });

    // Return newest posts first (by date, then by id), then apply limit.
    const sorted = posts.sort((a, b) => {
      const db = Date.parse(b.date || '') || 0;
      const da = Date.parse(a.date || '') || 0;
      if (db !== da) return db - da;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    });

    const latest = sorted.slice(0, limit);

    res.json({ channel, count: latest.length, posts: latest });
  } catch (err) {
    res.status(500).json({
      error: 'Failed to fetch/parse channel page',
      details: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Parser API started on http://localhost:${PORT}`);
});
