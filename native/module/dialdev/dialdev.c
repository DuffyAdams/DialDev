/* DialDev native SIP adapter. BSD-3-Clause. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifndef WIN32
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <unistd.h>
#endif
#include <re.h>
#include <rem.h>
#include <baresip.h>

struct capture { const struct audio *audio; char token[80]; char callid[256]; FILE *files[2]; uint32_t rates[2]; uint16_t channels[2]; uint32_t bytes[2]; bool failed; };
static struct capture captures[5];
/* Live transcription: each side of a call streams to a FIFO read by dialdev-transcribe, as frames of "DDA1", sample
 * rate (u32 LE), channels (u16 LE), reserved (u16), byte count (u32 LE) and s16le samples. Writes never block the audio
 * path: a frame that does not fit is dropped (the reader pads the gap), and a partly written frame is finished first. */
#define LIVE_BUFFER 65536
struct live { const struct audio *audio; int fds[2]; bool open[2]; size_t pending[2]; unsigned char buffer[2][LIVE_BUFFER]; };
static struct live lives[5];
static mtx_t capture_lock;
struct enc { struct aufilt_enc_st base; const struct audio *audio; };
struct dec { struct aufilt_dec_st base; const struct audio *audio; };
static void enc_destroy(void *arg) { struct enc *s = arg; list_unlink(&s->base.le); }
static void dec_destroy(void *arg) { struct dec *s = arg; list_unlink(&s->base.le); }
static int enc_update(struct aufilt_enc_st **stp, void **ctx, const struct aufilt *af, struct aufilt_prm *prm, const struct audio *au) { (void)ctx; (void)af; (void)prm; if (*stp) return 0; struct enc *s = mem_zalloc(sizeof(*s), enc_destroy); if (!s) return ENOMEM; s->audio = au; *stp = &s->base; return 0; }
static int dec_update(struct aufilt_dec_st **stp, void **ctx, const struct aufilt *af, struct aufilt_prm *prm, const struct audio *au) { (void)ctx; (void)af; (void)prm; if (*stp) return 0; struct dec *s = mem_zalloc(sizeof(*s), dec_destroy); if (!s) return ENOMEM; s->audio = au; *stp = &s->base; return 0; }
static void le16(unsigned char *p, uint16_t n) { p[0] = (unsigned char)n; p[1] = (unsigned char)(n >> 8); }
static void le32(unsigned char *p, uint32_t n) { for (int i = 0; i < 4; i++) p[i] = (unsigned char)(n >> (i * 8)); }
static void live_close(struct live *l, int side) {
#ifndef WIN32
  if (l->open[side]) close(l->fds[side]);
#endif
  l->open[side] = false; l->pending[side] = 0;
  if (!l->open[0] && !l->open[1]) l->audio = NULL;
}
static void live_frame(struct live *l, int side, const struct auframe *frame) {
#ifndef WIN32
  int fd = l->fds[side]; unsigned char *buffer = l->buffer[side];
  if (l->pending[side]) {
    ssize_t n = write(fd, buffer, l->pending[side]);
    if (n < 0) { if (errno != EAGAIN && errno != EINTR) live_close(l, side); return; }
    memmove(buffer, buffer + n, l->pending[side] - (size_t)n); l->pending[side] -= (size_t)n;
    if (l->pending[side]) return;
  }
  size_t bytes = frame->sampc * 2; if (16 + bytes > LIVE_BUFFER) return;
  unsigned char header[16]; memcpy(header, "DDA1", 4); le32(header + 4, frame->srate); le16(header + 8, frame->ch); le16(header + 10, 0); le32(header + 12, (uint32_t)bytes);
  struct iovec parts[2] = {{ header, sizeof(header) }, { frame->sampv, bytes }};
  ssize_t n = writev(fd, parts, 2);
  if (n < 0) { if (errno != EAGAIN && errno != EINTR) live_close(l, side); return; }
  size_t sent = (size_t)n; if (sent == 16 + bytes) return;
  if (sent < 16) { memcpy(buffer, header + sent, 16 - sent); memcpy(buffer + 16 - sent, frame->sampv, bytes); }
  else memcpy(buffer, (const unsigned char *)frame->sampv + (sent - 16), bytes - (sent - 16));
  l->pending[side] = 16 + bytes - sent;
#else
  (void)l; (void)side; (void)frame;
#endif
}
static void capture_frame(const struct audio *au, struct auframe *frame, int side) {
  mtx_lock(&capture_lock);
  if (frame->fmt == AUFMT_S16LE) for (size_t i = 0; i < RE_ARRAY_SIZE(lives); i++) if (lives[i].audio == au && lives[i].open[side]) live_frame(&lives[i], side, frame);
  for (size_t i = 0; i < RE_ARRAY_SIZE(captures); i++) {
    struct capture *c = &captures[i];
    if (c->audio != au || !c->files[side]) continue;
    if (frame->fmt != AUFMT_S16LE || c->bytes[side] > 1000000000) { c->failed = true; break; }
    if (c->rates[side] && (c->rates[side] != frame->srate || c->channels[side] != frame->ch)) { c->failed = true; break; }
    c->rates[side] = frame->srate; c->channels[side] = frame->ch;
    size_t written = fwrite(frame->sampv, 2, frame->sampc, c->files[side]);
    if (written != frame->sampc) c->failed = true;
    c->bytes[side] += (uint32_t)(written * 2);
  }
  mtx_unlock(&capture_lock);
}
static int encode(struct aufilt_enc_st *st, struct auframe *af) { capture_frame(((struct enc *)st)->audio, af, 0); return 0; }
static int decode(struct aufilt_dec_st *st, struct auframe *af) { capture_frame(((struct dec *)st)->audio, af, 1); return 0; }
static void finish_capture(struct capture *c) {
  for (int side = 0; side < 2; side++) if (c->files[side]) {
    unsigned char h[44] = {0}; uint32_t rate = c->rates[side] ? c->rates[side] : 8000; uint16_t ch = c->channels[side] ? c->channels[side] : 1;
    memcpy(h, "RIFF", 4); le32(h + 4, c->bytes[side] + 36); memcpy(h + 8, "WAVEfmt ", 8); le32(h + 16, 16); le16(h + 20, 1); le16(h + 22, ch); le32(h + 24, rate); le32(h + 28, rate * ch * 2); le16(h + 32, ch * 2); le16(h + 34, 16); memcpy(h + 36, "data", 4); le32(h + 40, c->bytes[side]);
    if (fseek(c->files[side], 0, SEEK_SET) || fwrite(h, 1, 44, c->files[side]) != 44) c->failed = true;
    if (fclose(c->files[side])) c->failed = true;
    c->files[side] = NULL;
  }
  module_event("dialdev", c->failed ? "recording-error" : "recording", NULL, NULL, "%s", c->token);
  memset(c, 0, sizeof(*c));
}
static bool valid_token(const char *token) { return token && strlen(token) <= 70 && strspn(token, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-") == strlen(token); }
static int record_call(struct call *call, const char *token, bool start) {
  int err = 0; mtx_lock(&capture_lock);
  if (!start) { for (size_t i = 0; i < RE_ARRAY_SIZE(captures); i++) if (captures[i].audio == call_audio(call)) finish_capture(&captures[i]); }
  else {
    struct capture *c = NULL;
    for (size_t i = 0; i < RE_ARRAY_SIZE(captures); i++) { if (captures[i].audio == call_audio(call)) { err = EALREADY; goto out; } if (!captures[i].audio) c = &captures[i]; }
    if (!c || !valid_token(token)) { err = EINVAL; goto out; }
    c->audio = call_audio(call); str_ncpy(c->token, token, sizeof(c->token)); str_ncpy(c->callid, call_id(call), sizeof(c->callid));
    for (int side = 0; side < 2; side++) { char file[1024]; re_snprintf(file, sizeof(file), "%s/%s-%d.wav", getenv("DIALDEV_REC_DIR"), token, side); c->files[side] = fopen(file, "wb"); if (!c->files[side]) { c->failed = true; err = EIO; break; } unsigned char blank[44] = {0}; fwrite(blank, 1, 44, c->files[side]); }
    if (err) finish_capture(c);
  }
 out: mtx_unlock(&capture_lock); return err;
}
/* Connects a call's audio to the FIFOs dialdev-transcribe created for this token, or disconnects it. */
static int transcribe_call(struct call *call, const char *token, bool start) {
#ifdef WIN32
  (void)call; (void)token; (void)start; return ENOSYS;
#else
  int err = 0; mtx_lock(&capture_lock);
  if (!start) { for (size_t i = 0; i < RE_ARRAY_SIZE(lives); i++) if (lives[i].audio == call_audio(call)) { live_close(&lives[i], 0); live_close(&lives[i], 1); } goto out; }
  struct live *l = NULL;
  for (size_t i = 0; i < RE_ARRAY_SIZE(lives); i++) { if (lives[i].audio == call_audio(call)) { err = EALREADY; goto out; } if (!lives[i].audio) l = &lives[i]; }
  if (!l || !valid_token(token) || !getenv("DIALDEV_REC_DIR")) { err = EINVAL; goto out; }
  memset(l, 0, sizeof(*l));
  for (int side = 0; side < 2; side++) {
    char file[1024]; struct stat st; re_snprintf(file, sizeof(file), "%s/%s-%d.fifo", getenv("DIALDEV_REC_DIR"), token, side);
    int fd = open(file, O_WRONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0 || fstat(fd, &st) || !S_ISFIFO(st.st_mode)) { err = fd < 0 ? errno : EINVAL; if (fd >= 0) close(fd); break; }
    l->fds[side] = fd; l->open[side] = true;
  }
  l->audio = call_audio(call);
  if (err) { live_close(l, 0); live_close(l, 1); }
 out: mtx_unlock(&capture_lock); return err;
#endif
}
static void event_handler(enum bevent_ev ev, struct bevent *event, void *arg) { (void)arg; if (ev == BEVENT_CALL_CLOSED) { struct call *call = bevent_get_call(event); if (call) { (void)record_call(call, NULL, false); (void)transcribe_call(call, NULL, false); } } }
static void message_response(int err, const struct sip_msg *msg, void *arg) { char *token = arg; if (!err && msg && msg->scode < 200) return; module_event("dialdev", "message", NULL, NULL, "%s %u", token, err ? 503 : msg ? msg->scode : 503); mem_deref(token); }
static int command(struct re_printf *pf, void *arg) {
  struct cmd_arg *carg = arg; struct odict *od = NULL; int err = json_decode_odict(&od, 32, carg->prm, str_len(carg->prm), 8); if (err) return err;
  const char *action = odict_string(od, "action"); const char *cid = odict_string(od, "call"); const char *aor = odict_string(od, "aor"); const char *to = odict_string(od, "to");
  struct call *call = cid ? uag_call_find(cid) : NULL; struct ua *ua = aor ? uag_find_aor(aor) : NULL;
  if (!action) { err = EINVAL; goto out; }
  if (!strcmp(action, "connect")) {
    err = ua_alloc(&ua, odict_string(od, "address")); if (err) goto out;
    struct account *acc = ua_account(ua);
    err = account_set_auth_user(acc, odict_string(od, "authUser")); err |= account_set_auth_pass(acc, odict_string(od, "password"));
    err |= account_set_display_name(acc, odict_string(od, "displayName"));
    if (err) { mem_deref(ua); goto out; }
    err = ua_register(ua); if (err) mem_deref(ua); else re_hprintf(pf, "%s", account_aor(acc));
  }
  else if (!strcmp(action, "disconnect")) { if (!ua) { err = ENOENT; goto out; } ua_unregister(ua); mem_deref(ua); }
  else if (!strcmp(action, "dial")) { if (!ua || !to) { err = EINVAL; goto out; } struct call *newcall = NULL; err = ua_connect(ua, &newcall, NULL, to, VIDMODE_OFF); if (!err) re_hprintf(pf, "%s", call_id(newcall)); }
  else if (!strcmp(action, "message")) { if (!ua || !to) { err = EINVAL; goto out; } char *token = NULL; err = str_dup(&token, odict_string(od, "token")); if (!err) err = message_send(ua, to, odict_string(od, "body"), message_response, token); if (err) mem_deref(token); }
  else if (!strcmp(action, "split") || !strcmp(action, "merge")) { bool merge = !strcmp(action, "merge"); for (struct le *le = list_head(uag_list()); le; le = le->next) for (struct le *lc = list_head(ua_calls(le->data)); lc; lc = lc->next) { struct call *c = lc->data; if (merge) call_hold(c, false); audio_set_conference(call_audio(c), merge); } }
  else if (!call) err = ENOENT;
  else if (!strcmp(action, "answer")) err = ua_answer(call_get_ua(call), call, VIDMODE_OFF);
  else if (!strcmp(action, "end")) ua_hangup(call_get_ua(call), call, 486, "Busy Here");
  else if (!strcmp(action, "forward")) ua_hangupf(call_get_ua(call), call, 302, "Moved Temporarily", "Contact: <%s>\r\n", to);
  else if (!strcmp(action, "hold")) err = call_hold(call, true);
  else if (!strcmp(action, "resume")) err = call_hold(call, false);
  else if (!strcmp(action, "mute")) audio_mute(call_audio(call), true);
  else if (!strcmp(action, "unmute")) audio_mute(call_audio(call), false);
  else if (!strcmp(action, "dtmf")) { if (!to || !strchr("0123456789*#", *to)) { err = EINVAL; goto out; } err = call_send_digit(call, *to); if (!err) err = call_send_digit(call, KEYCODE_REL); }
  else if (!strcmp(action, "transfer")) err = call_transfer(call, to);
  else if (!strcmp(action, "attended")) { struct call *other = uag_call_find(odict_string(od, "other")); if (!other) err = ENOENT; else err = call_replace_transfer(call, other); }
  else if (!strcmp(action, "record")) err = record_call(call, odict_string(od, "token"), true);
  else if (!strcmp(action, "record-stop")) err = record_call(call, NULL, false);
  else if (!strcmp(action, "transcribe")) err = transcribe_call(call, odict_string(od, "token"), true);
  else if (!strcmp(action, "transcribe-stop")) err = transcribe_call(call, NULL, false);
  else err = EINVAL;
 out: mem_deref(od); return err;
}
static const struct cmd commands[] = {{ "dialdev", 0, CMD_PRM, "DialDev IPC", command }};
static struct aufilt filter = { .name = "dialdev", .encupdh = enc_update, .ench = encode, .decupdh = dec_update, .dech = decode };
static int module_init(void) {
#ifndef WIN32
  /* A transcription helper that exits closes its FIFO; report that as EPIPE instead of terminating the engine. */
  signal(SIGPIPE, SIG_IGN);
#endif
  if (mtx_init(&capture_lock, mtx_plain) != thrd_success) return ENOMEM; aufilt_register(baresip_aufiltl(), &filter); return cmd_register(baresip_commands(), commands, RE_ARRAY_SIZE(commands)) | bevent_register(event_handler, NULL); }
static int module_close(void) { bevent_unregister(event_handler); cmd_unregister(baresip_commands(), commands); aufilt_unregister(&filter); mtx_lock(&capture_lock); for (size_t i = 0; i < RE_ARRAY_SIZE(captures); i++) if (captures[i].audio) finish_capture(&captures[i]); for (size_t i = 0; i < RE_ARRAY_SIZE(lives); i++) { live_close(&lives[i], 0); live_close(&lives[i], 1); } mtx_unlock(&capture_lock); mtx_destroy(&capture_lock); return 0; }
EXPORT_SYM const struct mod_export DECL_EXPORTS(dialdev) = { "dialdev", "application", module_init, module_close };
