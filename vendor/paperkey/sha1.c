/*
 * Minimal SHA-1 implementation for paperkey emscripten build.
 * Based on public-domain SHA-1 implementation.
 */
#include "sha1.h"
#include <string.h>

#define S(x,n) (((x) << (n)) | (((x) & 0xffffffff) >> (32 - (n))))

static const uint32_t K[4] = { 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6 };

static void sha1_transform(uint32_t state[5], const uint8_t buffer[64])
{
  uint32_t a, b, c, d, e;
  uint32_t w[80];
  int i;

  for (i = 0; i < 16; i++)
    w[i] = ((uint32_t)buffer[i*4] << 24) | ((uint32_t)buffer[i*4+1] << 16) |
           ((uint32_t)buffer[i*4+2] << 8) | (uint32_t)buffer[i*4+3];
  for (i = 16; i < 80; i++)
    w[i] = S(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1);

  a = state[0]; b = state[1]; c = state[2]; d = state[3]; e = state[4];

  for (i = 0; i < 80; i++)
    {
      uint32_t temp, f;
      int k = i / 20;
      if (i < 20)
        f = (b & c) | ((~b) & d);
      else if (i < 40)
        f = b ^ c ^ d;
      else if (i < 60)
        f = (b & c) | (b & d) | (c & d);
      else
        f = b ^ c ^ d;

      temp = S(a, 5) + f + e + K[k] + w[i];
      e = d;
      d = c;
      c = S(b, 30);
      b = a;
      a = temp;
    }

  state[0] += a; state[1] += b; state[2] += c; state[3] += d; state[4] += e;
}

void sha1_init_ctx(struct sha1_ctx *ctx)
{
  ctx->state[0] = 0x67452301;
  ctx->state[1] = 0xefcdab89;
  ctx->state[2] = 0x98badcfe;
  ctx->state[3] = 0x10325476;
  ctx->state[4] = 0xc3d2e1f0;
  ctx->count = 0;
  memset(ctx->buffer, 0, 64);
}

void sha1_process_bytes(const void *buffer, size_t len, struct sha1_ctx *ctx)
{
  const uint8_t *p = (const uint8_t *)buffer;
  size_t idx = ctx->count % 64;

  ctx->count += len;

  if (idx > 0)
    {
      size_t left = 64 - idx;
      size_t n = (len < left) ? len : left;
      memcpy(ctx->buffer + idx, p, n);
      if (idx + n < 64)
        return;
      sha1_transform(ctx->state, ctx->buffer);
      p += n;
      len -= n;
    }

  while (len >= 64)
    {
      sha1_transform(ctx->state, p);
      p += 64;
      len -= 64;
    }

  if (len > 0)
    memcpy(ctx->buffer, p, len);
}

void sha1_finish_ctx(struct sha1_ctx *ctx, void *resbuf)
{
  uint8_t *r = (uint8_t *)resbuf;
  uint64_t bits = ctx->count * 8;
  size_t idx = ctx->count % 64;
  size_t padlen = (idx < 56) ? (56 - idx) : (120 - idx);
  uint8_t pad[120];
  int i;

  memset(pad, 0, padlen);
  pad[0] = 0x80;

  sha1_process_bytes(pad, padlen, ctx);

  for (i = 0; i < 8; i++)
    pad[i] = (uint8_t)((bits >> (56 - i * 8)) & 0xff);
  sha1_process_bytes(pad, 8, ctx);

  for (i = 0; i < 5; i++)
    {
      r[i*4] = (uint8_t)((ctx->state[i] >> 24) & 0xff);
      r[i*4+1] = (uint8_t)((ctx->state[i] >> 16) & 0xff);
      r[i*4+2] = (uint8_t)((ctx->state[i] >> 8) & 0xff);
      r[i*4+3] = (uint8_t)(ctx->state[i] & 0xff);
    }
}
