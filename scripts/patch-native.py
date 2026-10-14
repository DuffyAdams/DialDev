from pathlib import Path
import sys
p=Path(sys.argv[1])/'modules/ctrl_tcp/ctrl_tcp.c'
s=p.read_text()
if 'DIALDEV_CTRL_TOKEN' not in s:
 s=s.replace('#include <re.h>','#include <re.h>\n#include <stdlib.h>\n#include <string.h>')
 s=s.replace('struct tcp_sock *ts;', 'bool authenticated;\n\tstruct tcp_sock *ts;')
 s=s.replace('char buf[1024];', 'char buf[16384];')
 s=s.replace('cmd = odict_string(od, "command");', '''const char *auth = odict_string(od, "auth");
 const char *expected = getenv("DIALDEV_CTRL_TOKEN");
 if (!auth || !expected || strcmp(auth, expected)) goto out;
 st->authenticated = true;
 cmd = odict_string(od, "command");''')
 s=s.replace('/* only one connection allowed */','''/* The owning process keeps this authenticated socket for its lifetime. */
 if (st->tc) { struct tcp_conn *rejected = NULL; (void)tcp_accept(&rejected, st->ts, NULL, NULL, NULL, NULL); mem_deref(rejected); return; }
 st->authenticated = false;
 /* only one connection allowed */''')
 s=s.replace('if (st->tc) {\n\t\tbuf->pos', 'if (st->tc && st->authenticated) {\n\t\tbuf->pos')
 s=s.replace('if (!st->tc)\n\t\tgoto out;', 'if (!st->tc || !st->authenticated)\n\t\tgoto out;')
 s=s.replace('debug("ctrl_tcp: handle_command:  cmd=\'%s\', params:\'%s\', token=\'%s\'\\n",\n\t      cmd, prm, tok);', '/* Never log command parameters: they may contain credentials. */')
 p.write_text(s)

# audiounit always opens the Mac's default input and output, ignoring the device in "audio_source audiounit,<name>". Open the
# named device instead, so calls use the microphone and speaker chosen in DialDev; fall back to the default when it isn't connected.
def patch(path, old, new):
 f=Path(sys.argv[1])/'modules/audiounit'/path
 s=f.read_text()
 if new in s: return
 if old not in s: sys.exit(f'patch-native: {path} changed upstream')
 f.write_text(s.replace(old,new,1))
patch('audiounit.h', 'uint32_t audiounit_aufmt_to_formatflags(enum aufmt fmt);', '''uint32_t audiounit_aufmt_to_formatflags(enum aufmt fmt);
#include <TargetConditionals.h>
#if ! TARGET_OS_IPHONE
#include <CoreAudio/CoreAudio.h>
bool audiounit_find_device(const char *name, bool input, AudioDeviceID *id);
#endif''')
patch('audiounit.c', 'static int module_init(void)', '''#if ! TARGET_OS_IPHONE
/* Finds the device called `name` that has streams in the given direction. False for "", "default" or no such device. */
bool audiounit_find_device(const char *name, bool input, AudioDeviceID *id)
{
	AudioObjectPropertyAddress all = { kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
	AudioObjectPropertyAddress streams = { kAudioDevicePropertyStreams, input ? kAudioObjectPropertyScopeInput : kAudioObjectPropertyScopeOutput, kAudioObjectPropertyElementMain };
	AudioObjectPropertyAddress label = { kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
	AudioDeviceID *devices;
	UInt32 size = 0;
	bool found = false;

	if (!str_isset(name) || !str_casecmp(name, "default"))
		return false;
	if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &all, 0, NULL, &size) || !size)
		return false;
	devices = mem_alloc(size, NULL);
	if (!devices)
		return false;
	if (!AudioObjectGetPropertyData(kAudioObjectSystemObject, &all, 0, NULL, &size, devices)) {
		for (UInt32 i = 0; i < size / sizeof(*devices) && !found; i++) {
			CFStringRef cf = NULL;
			UInt32 n = 0, cfsize = sizeof(cf);
			char text[256];

			if (AudioObjectGetPropertyDataSize(devices[i], &streams, 0, NULL, &n) || !n)
				continue;
			if (AudioObjectGetPropertyData(devices[i], &label, 0, NULL, &cfsize, &cf) || !cf)
				continue;
			if (CFStringGetCString(cf, text, sizeof(text), kCFStringEncodingUTF8) && !str_cmp(text, name)) {
				*id = devices[i];
				found = true;
			}
			CFRelease(cf);
		}
	}
	mem_deref(devices);
	if (!found)
		warning("audiounit: no %s device named '%s'; using the default\\n", input ? "input" : "output", name);
	return found;
}
#endif


static int module_init(void)''')
patch('recorder.c', '''	ret = AudioObjectGetPropertyData(kAudioObjectSystemObject,
			&auAddress,
			0,
			NULL,
			&ausize,
			&inputDevice);
	if (ret)
		goto out;''', '''	if (!audiounit_find_device(device, true, &inputDevice)) {
		ret = AudioObjectGetPropertyData(kAudioObjectSystemObject,
				&auAddress,
				0,
				NULL,
				&ausize,
				&inputDevice);
		if (ret)
			goto out;
	}''')
patch('player.c', '''	ret = AudioUnitInitialize(st->au);''', '''#if ! TARGET_OS_IPHONE
	{
		AudioDeviceID outputDevice;
		if (audiounit_find_device(device, false, &outputDevice)) {
			ret = AudioUnitSetProperty(st->au, kAudioOutputUnitProperty_CurrentDevice,
						   kAudioUnitScope_Global, 0, &outputDevice, sizeof(outputDevice));
			if (ret)
				goto out;
		}
	}
#endif

	ret = AudioUnitInitialize(st->au);''')
