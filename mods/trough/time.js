export function localTime(iso) {
  const date=new Date(iso);
  return Number.isNaN(date.getTime())?iso:date.toLocaleString();
}

export function relativeTime(iso,now=Date.now()) {
  const date=new Date(iso),time=date.getTime();
  if(!Number.isFinite(time)) return iso;
  const age=Math.max(0,now-time);
  if(age<60000) return 'just now';
  if(age<3600000) return `${Math.floor(age/60000)}m ago`;
  if(age<86400000) return `${Math.floor(age/3600000)}h ago`;
  const today=new Date(now),yesterday=new Date(today.getFullYear(),today.getMonth(),today.getDate()-1);
  const day=new Date(date.getFullYear(),date.getMonth(),date.getDate());
  if(day.getTime()===yesterday.getTime()) return 'yesterday';
  if(age<7*86400000) return `${Math.floor(age/86400000)}d ago`;
  return date.toLocaleDateString(undefined,{month:'short',day:'numeric',...(date.getFullYear()!==today.getFullYear()?{year:'numeric'}:{})});
}
