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
