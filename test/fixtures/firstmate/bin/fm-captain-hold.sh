#!/usr/bin/env bash
set -eu
case "${1:-}" in
  open)
    [ "${3:-}" = --identity ] || exit 2
    [ -f "$FM_HOME/state/$2.hold" ] || exit 1
    cat "$FM_HOME/state/$2.hold"
    ;;
  answer)
    task=$2
    [ "${3:-}" = --decision-file ] || exit 2
    decision_file=$4
    mode=done
    [ "${5:-}" != --release ] || mode=release
    [ -f "$FM_HOME/state/$task.hold" ] || exit 1
    node -e '
      const fs=require("node:fs");
      const home=process.env.FM_HOME,task=process.argv[1],file=process.argv[2],mode=process.argv[3];
      const words=fs.readFileSync(file,"utf8");
      fs.appendFileSync(`${home}/answers.log`,JSON.stringify({task,words,mode})+"\n");
      const snapshot=JSON.parse(fs.readFileSync(`${home}/fixture-snapshot.json`,"utf8"));
      const row=snapshot.backlog.records.find(row=>row.id===task);
      if(mode==="done") row.state="done"; else row.hold_kind=null;
      fs.writeFileSync(`${home}/fixture-snapshot.json`,JSON.stringify(snapshot));
    ' "$task" "$decision_file" "$mode"
    mv "$FM_HOME/state/$task.hold" "$FM_HOME/state/$task.answered"
    ;;
  *) exit 2 ;;
esac
