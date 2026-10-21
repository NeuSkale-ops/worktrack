use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct Applications(BTreeMap<String, f64>);
#[derive(Serialize)]
pub struct Usage {
    pub app: String,
    pub milliseconds: u64,
}
impl Applications {
    pub fn record(&mut self, app: Option<&str>, seconds: f64) {
        if !seconds.is_finite() || seconds <= 0.0 {
            return;
        }
        let app = app.unwrap_or("Unknown");
        let app = if self.0.contains_key(app) || self.0.len() < 31 {
            app
        } else {
            "Other"
        };
        *self.0.entry(app.to_owned()).or_default() += seconds;
    }
    pub fn snapshot(&self, seconds: i64) -> Vec<Usage> {
        let mut remaining = seconds.max(0) as u64 * 1000;
        self.0
            .iter()
            .filter_map(|(app, seconds)| {
                let milliseconds = ((*seconds * 1000.0).floor() as u64).min(remaining);
                remaining -= milliseconds;
                (milliseconds > 0).then(|| Usage {
                    app: app.clone(),
                    milliseconds,
                })
            })
            .collect()
    }
    pub fn clear(&mut self) {
        self.0.clear();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn samples_aggregate_and_never_exceed_block_or_name_budget() {
        let mut apps = Applications::default();
        apps.record(Some("chrome.exe"), 1.25);
        apps.record(Some("chrome.exe"), 2.25);
        apps.record(None, 0.5);
        let values = apps.snapshot(4);
        assert_eq!(values.iter().map(|a| a.milliseconds).sum::<u64>(), 4000);
        assert_eq!(
            values
                .iter()
                .find(|a| a.app == "chrome.exe")
                .unwrap()
                .milliseconds,
            3500
        );
        for i in 0..100 {
            apps.record(Some(&format!("app{i}.exe")), 1.0);
        }
        assert!(apps.snapshot(600).len() <= 32);
        assert_eq!(
            apps.snapshot(2).iter().map(|a| a.milliseconds).sum::<u64>(),
            2000
        );
        apps.clear();
        assert!(apps.snapshot(30).is_empty());
    }
}
