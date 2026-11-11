const labels={info:'INFO',notice:'NOTE',warning:'WARN',critical:'CRIT'};

export const severityLabel=severity=>labels[severity]??severity;
