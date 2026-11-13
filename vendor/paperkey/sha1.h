#ifndef SHA1_H
#define SHA1_H

#include <stddef.h>
#include <stdint.h>

struct sha1_ctx
{
  uint32_t state[5];
  uint64_t count;
  uint8_t buffer[64];
};

void sha1_init_ctx(struct sha1_ctx *ctx);
void sha1_process_bytes(const void *buffer, size_t len, struct sha1_ctx *ctx);
void sha1_finish_ctx(struct sha1_ctx *ctx, void *resbuf);

#endif
