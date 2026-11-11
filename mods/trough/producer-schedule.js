// The pane owns this schedule. A due producer cannot be selected again until its run finishes.
export class ProducerSchedule {
  constructor(producers) {
    this.producers=producers;
    this.next=new Map();
    this.running=new Set();
  }
  due(now) {
    const ready=[];
    for(const producer of this.producers) {
      if(producer.error||this.running.has(producer.id)||now<(this.next.get(producer.id)??0)) continue;
      this.running.add(producer.id);
      this.next.set(producer.id,now+producer.interval_seconds*1000);
      ready.push(producer);
    }
    return ready;
  }
  complete(id) { this.running.delete(id); }
}
