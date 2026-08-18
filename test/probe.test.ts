import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseProbe, probeSignature, type RawProbe } from '../src/probe';

test('maps a simple h264 + stereo aac mp4', () => {
  const raw: RawProbe = {
    streams: [
      {
        index: 0,
        codec_name: 'h264',
        codec_type: 'video',
        profile: 'High',
        level: 40,
        width: 1280,
        height: 720,
        color_space: 'bt709',
        bits_per_raw_sample: '8',
        avg_frame_rate: '24/1',
        display_aspect_ratio: '16:9',
        bit_rate: '2500000',
        disposition: { default: 1, forced: 0 },
      },
      {
        index: 1,
        codec_name: 'aac',
        codec_type: 'audio',
        channels: 2,
        channel_layout: 'stereo',
        sample_rate: '48000',
        bit_rate: '128000',
        tags: { language: 'eng' },
        disposition: { default: 1, forced: 0 },
      },
    ],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: '634.533333',
      size: '198000000',
      bit_rate: '2650000',
    },
  };

  const r = normaliseProbe(raw);
  assert.equal(r.container, 'mp4');
  assert.equal(r.durationSec, 634.533333);
  assert.equal(r.bitrate, 2650000);
  assert.equal(r.sizeBytes, 198000000);
  assert.equal(r.streams.length, 2);

  const video = r.streams[0];
  assert.equal(video.kind, 'video');
  if (video.kind === 'video') {
    assert.equal(video.codec, 'h264');
    assert.equal(video.width, 1280);
    assert.equal(video.height, 720);
    assert.equal(video.frameRate, 24);
    assert.equal(video.bitDepth, 8);
    assert.equal(video.profile, 'High');
    assert.equal(video.level, 40);
    assert.equal(video.colorSpace, 'bt709');
    assert.equal(video.aspectRatio, '16:9');
    assert.equal(video.bitrate, 2500000);
    assert.equal(video.default, true);
  }

  const audio = r.streams[1];
  assert.equal(audio.kind, 'audio');
  if (audio.kind === 'audio') {
    assert.equal(audio.codec, 'aac');
    assert.equal(audio.channels, 2);
    assert.equal(audio.channelLayout, 'stereo');
    assert.equal(audio.sampleRate, 48000);
    assert.equal(audio.language, 'eng');
  }
});

test('maps hevc 10-bit + 5.1 + second audio + embedded subtitle', () => {
  const raw: RawProbe = {
    streams: [
      {
        index: 0,
        codec_name: 'hevc',
        codec_type: 'video',
        width: 3840,
        height: 2160,
        bits_per_raw_sample: '10',
        r_frame_rate: '24000/1001',
        avg_frame_rate: '24000/1001',
        color_space: 'bt2020nc',
      },
      {
        index: 1,
        codec_name: 'eac3',
        codec_type: 'audio',
        channels: 6,
        channel_layout: '5.1',
        tags: { language: 'eng', title: 'Surround' },
        disposition: { default: 1, forced: 0 },
      },
      {
        index: 2,
        codec_name: 'aac',
        codec_type: 'audio',
        channels: 2,
        tags: { language: 'fra' },
      },
      {
        index: 3,
        codec_name: 'subrip',
        codec_type: 'subtitle',
        tags: { language: 'eng', title: 'English (SDH)' },
        disposition: { default: 0, forced: 1 },
      },
      { index: 4, codec_type: 'data', codec_name: 'bin_data' },
    ],
    format: { format_name: 'matroska,webm', duration: '100' },
  };

  const r = normaliseProbe(raw);
  assert.equal(r.container, 'mkv');
  // data stream dropped
  assert.equal(r.streams.length, 4);
  assert.equal(r.streams.filter((s) => s.kind === 'audio').length, 2);

  const video = r.streams[0];
  if (video.kind === 'video') {
    assert.equal(video.bitDepth, 10);
    assert.equal(video.height, 2160);
    assert.equal(video.frameRate, 23.976);
  }

  const sub = r.streams[3];
  assert.equal(sub.kind, 'subtitle');
  if (sub.kind === 'subtitle') {
    assert.equal(sub.language, 'eng');
    assert.equal(sub.title, 'English (SDH)');
    assert.equal(sub.forced, true);
    assert.equal(sub.default, false);
  }
});

test('treats "und" language as absent and tolerates missing fields', () => {
  const raw: RawProbe = {
    streams: [
      { index: 0, codec_type: 'audio', codec_name: 'mp3', tags: { language: 'und' } },
      { index: 1, codec_type: 'video', codec_name: 'mpeg4' },
    ],
    format: {},
  };
  const r = normaliseProbe(raw);
  assert.equal(r.container, null);
  assert.equal(r.durationSec, null);
  const audio = r.streams[0];
  if (audio.kind === 'audio') {
    assert.equal(audio.language, null);
    assert.equal(audio.channels, null);
  }
  const video = r.streams[1];
  if (video.kind === 'video') {
    assert.equal(video.frameRate, null);
    assert.equal(video.width, null);
  }
});

test('empty input yields an empty result', () => {
  const r = normaliseProbe({});
  assert.deepEqual(r.streams, []);
  assert.equal(r.container, null);
});

test('probeSignature is stable and URL-sensitive', () => {
  const a = probeSignature('https://example.com/a.mp4');
  const b = probeSignature('https://example.com/a.mp4');
  const c = probeSignature('https://example.com/b.mp4');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});
