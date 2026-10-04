#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct InputTarget {
    pub window: isize,
    pub focus: isize,
    pub process: u32,
    pub title: String,
}
