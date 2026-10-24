import json, os, re, signal, subprocess, sys, time
from pathlib import Path
helper=Path(__file__).resolve().parent
out=Path(sys.argv[1]).resolve(); cwd=Path(sys.argv[2]).resolve(); label=sys.argv[3]; command=sys.argv[4:]
out.mkdir(parents=True,exist_ok=True)
tmp=Path(os.environ.get('WITCH_MEASURE_TMPDIR',str(out/'suite-tmp')));tmp.mkdir(parents=True,exist_ok=True)
runtime=out/(label+'.runtime.json');report=out/(label+'.cases.json')
env=dict(os.environ,TMPDIR=str(tmp),LC_ALL='C',WITCH_CAPTURE_CWD=str(cwd),WITCH_CAPTURE_REPORT=str(report),WITCH_CAPTURE_RUNTIME=str(runtime),NODE_OPTIONS='--import '+str(helper/'capture-vitest.mjs'))
seen={};peak=0;test_peak=0;test_seen=set();started=time.monotonic();test_pid=None

def rows():
 output=subprocess.run(['ps','-axo','pid=,ppid=,pgid=,rss=,lstart=,command='],capture_output=True,text=True,check=True).stdout
 result={}
 for line in output.splitlines():
  fields=line.split(None,9)
  if len(fields)==10:
   pid,parent,group,rss=map(int,fields[:4]);result[pid]={'pid':pid,'parent':parent,'group':group,'rss':rss,'started':' '.join(fields[4:9]),'command':fields[9]}
 return result

def sample():
 global peak,test_peak,test_pid
 current=rows()
 owned={pid for pid,r in current.items() if r['group']==child.pid or (pid in seen and seen[pid]['started']==r['started'])}
 while True:
  more={pid for pid,r in current.items() if r['parent'] in owned}
  if more <= owned:break
  owned |= more
 for pid in owned:seen[pid]=current[pid]
 peak=max(peak,sum(current[pid]['rss'] for pid in owned))
 if test_pid is None and runtime.exists():test_pid=json.loads(runtime.read_text())['pid']
 if test_pid is not None:
  test_owned={pid for pid in owned if pid==test_pid or pid in test_seen}
  while True:
   more={pid for pid in owned if current[pid]['parent'] in test_owned}
   if more<=test_owned:break
   test_owned |= more
  test_seen.update(test_owned)
  test_peak=max(test_peak,sum(current[pid]['rss'] for pid in test_owned))
 return [current[pid] for pid in owned if pid!=child.pid]

with (out/(label+'.log')).open('w') as log:
 child=subprocess.Popen(command,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 try:
  while child.poll() is None:
   sample()
   if time.monotonic()-started>1200:raise TimeoutError(label)
   time.sleep(.5)
  survivors=sample();deadline=time.monotonic()+5
  while survivors and time.monotonic()<deadline:
   time.sleep(.25);survivors=sample()
  opened=subprocess.run(['lsof','-nP','+D',str(tmp)],capture_output=True,text=True)
  files=[str(p.relative_to(tmp)) for p in tmp.rglob('*') if p.is_file()]
  unexpected=[p for p in files if not (p.startswith('node-compile-cache/') or re.fullmatch(r'tsx-\d+',p.split('/')[0]))]
  result={'label':label,'command':command,'cwd':str(cwd),'code':child.returncode,'seconds':time.monotonic()-started,'peak_sampled_rss_kib':peak,'suite_peak_sampled_rss_kib':test_peak,'owned_processes':list(seen.values()),'survivors':survivors,'open_files':opened.stdout,'lsof_code':opened.returncode,'lsof_stderr':opened.stderr,'remaining_files':files,'unexpected_files':unexpected}
  (out/(label+'.measurement.json')).write_text(json.dumps(result,indent=2)+'\n')
  assert not survivors and not opened.stdout and not opened.stderr and not unexpected, 'resources remained; inspect measurement'
  assert child.returncode==0, 'command failed; inspect log'
  cases=json.loads(report.read_text())
  assert cases['numFailedTests']==0 and cases['numPendingTests']==0
  print(json.dumps({k:result[k] for k in ['label','code','seconds','suite_peak_sampled_rss_kib','survivors','unexpected_files']}),flush=True)
 finally:
  if child.poll() is None:
   os.killpg(child.pid,signal.SIGKILL);child.wait()
  current=rows()
  for pid,row in seen.items():
   if pid!=child.pid and pid in current and current[pid]['started']==row['started']:
    try:os.kill(pid,signal.SIGKILL)
    except ProcessLookupError:pass
