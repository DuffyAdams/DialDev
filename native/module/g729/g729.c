/* G.729 Annex A audio codec for DialDev's native engine, using bcg729 (GPL-3.0-or-later; see native/licenses/bcg729.txt).
 *
 * G.729 codes 10 ms frames of 8 kHz audio (80 samples) into 10 bytes, so an RTP packet carries one frame per 10 ms of
 * ptime. DialDev sends without voice-activity detection and offers "annexb=no", but still decodes the 2-byte Annex B
 * comfort-noise (SID) frame a far end may send at the end of a packet. */
#include <re.h>
#include <rem.h>
#include <baresip.h>
#include <bcg729/encoder.h>
#include <bcg729/decoder.h>

enum { FRAME_SAMPLES = 80, FRAME_BYTES = 10, SID_BYTES = 2, DEFAULT_FRAMES = 2 };

struct auenc_state { bcg729EncoderChannelContextStruct *ctx; };
/* frames: speech frames in the last packet received, the length a lost packet is concealed with. */
struct audec_state { bcg729DecoderChannelContextStruct *ctx; size_t frames; };

static void enc_destructor(void *arg) { struct auenc_state *st = arg; if (st->ctx) closeBcg729EncoderChannel(st->ctx); }
static void dec_destructor(void *arg) { struct audec_state *st = arg; if (st->ctx) closeBcg729DecoderChannel(st->ctx); }

static int encode_update(struct auenc_state **aesp, const struct aucodec *ac, struct auenc_param *prm, const char *fmtp)
{
	(void)ac; (void)prm; (void)fmtp;
	if (!aesp) return EINVAL;
	if (*aesp) return 0;
	struct auenc_state *st = mem_zalloc(sizeof(*st), enc_destructor);
	if (!st) return ENOMEM;
	st->ctx = initBcg729EncoderChannel(0);
	if (!st->ctx) { mem_deref(st); return ENOMEM; }
	*aesp = st;
	return 0;
}

static int encode(struct auenc_state *st, bool *marker, uint8_t *buf, size_t *len, int fmt, const void *sampv, size_t sampc)
{
	const int16_t *p = sampv; size_t out = 0;
	(void)marker;
	if (!st || !buf || !len || !sampv) return EINVAL;
	if (fmt != AUFMT_S16LE) return ENOTSUP;
	/* G.729 packet times are whole 10 ms frames. */
	if (!sampc || sampc % FRAME_SAMPLES) return EINVAL;
	if (*len < sampc / FRAME_SAMPLES * FRAME_BYTES) return ENOMEM;
	for (size_t i = 0; i < sampc; i += FRAME_SAMPLES) {
		uint8_t n = 0;
		bcg729Encoder(st->ctx, p + i, buf + out, &n);
		out += n;
	}
	*len = out;
	return 0;
}

static int decode_update(struct audec_state **adsp, const struct aucodec *ac, const char *fmtp)
{
	(void)ac; (void)fmtp;
	if (!adsp) return EINVAL;
	if (*adsp) return 0;
	struct audec_state *st = mem_zalloc(sizeof(*st), dec_destructor);
	if (!st) return ENOMEM;
	st->ctx = initBcg729DecoderChannel();
	if (!st->ctx) { mem_deref(st); return ENOMEM; }
	st->frames = DEFAULT_FRAMES;
	*adsp = st;
	return 0;
}

static int decode(struct audec_state *st, int fmt, void *sampv, size_t *sampc, bool marker, const uint8_t *buf, size_t len)
{
	int16_t *p = sampv; size_t frames = len / FRAME_BYTES, sid = len % FRAME_BYTES;
	(void)marker;
	if (!st || !sampv || !sampc || !buf) return EINVAL;
	if (fmt != AUFMT_S16LE) return ENOTSUP;
	/* Speech frames, optionally followed by one comfort-noise frame. */
	if (sid && sid != SID_BYTES) return EBADMSG;
	if (*sampc < (frames + (sid ? 1 : 0)) * FRAME_SAMPLES) return ENOMEM;
	for (size_t i = 0; i < frames; i++)
		bcg729Decoder(st->ctx, buf + i * FRAME_BYTES, FRAME_BYTES, 0, 0, 0, p + i * FRAME_SAMPLES);
	if (sid)
		bcg729Decoder(st->ctx, buf + frames * FRAME_BYTES, SID_BYTES, 0, 1, 0, p + frames * FRAME_SAMPLES);
	if (frames) st->frames = frames;
	*sampc = (frames + (sid ? 1 : 0)) * FRAME_SAMPLES;
	return 0;
}

/* Conceals one lost packet, assumed as long as the last one received. */
static int plc(struct audec_state *st, int fmt, void *sampv, size_t *sampc, const uint8_t *buf, size_t len)
{
	int16_t *p = sampv; size_t frames;
	(void)buf; (void)len;
	if (!st || !sampv || !sampc) return EINVAL;
	if (fmt != AUFMT_S16LE) return ENOTSUP;
	frames = st->frames;
	if (*sampc < frames * FRAME_SAMPLES) return ENOMEM;
	for (size_t i = 0; i < frames; i++)
		bcg729Decoder(st->ctx, NULL, 0, 1, 0, 0, p + i * FRAME_SAMPLES);
	*sampc = frames * FRAME_SAMPLES;
	return 0;
}

static struct aucodec g729 = {
	.pt      = "18",
	.name    = "G729",
	.srate   = 8000,
	.crate   = 8000,
	.ch      = 1,
	.pch     = 1,
	.fmtp    = "annexb=no",
	.encupdh = encode_update,
	.ench    = encode,
	.decupdh = decode_update,
	.dech    = decode,
	.plch    = plc,
};

static int module_init(void) { aucodec_register(baresip_aucodecl(), &g729); return 0; }
static int module_close(void) { aucodec_unregister(&g729); return 0; }

EXPORT_SYM const struct mod_export DECL_EXPORTS(g729) = { "g729", "audio codec", module_init, module_close };
