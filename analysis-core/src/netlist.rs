//! Parsing and validation for Yosys JSON netlists.

use deepsize::DeepSizeOf;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum NetlistError {
    #[error("invalid yosys json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("top module {0:?} not found")]
    TopNotFound(String),
    #[error("no top module found in yosys json")]
    NoTop,
    #[error("multiple possible top modules found")]
    AmbiguousTop,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YosysNetlist {
    pub modules: BTreeMap<String, YosysModule>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YosysModule {
    #[serde(default)]
    pub attributes: BTreeMap<String, String>,
    #[serde(default)]
    pub ports: BTreeMap<String, YosysPort>,
    #[serde(default)]
    pub cells: BTreeMap<String, YosysCell>,
    #[serde(default)]
    pub netnames: BTreeMap<String, YosysNetname>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YosysPort {
    pub direction: PortDirection,
    #[serde(default)]
    pub bits: Vec<YosysBit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, DeepSizeOf)]
#[serde(rename_all = "lowercase")]
pub enum PortDirection {
    Input,
    Output,
    Inout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YosysCell {
    #[serde(rename = "type")]
    pub cell_type: String,
    #[serde(default)]
    pub hide_name: u8,
    #[serde(default)]
    pub parameters: BTreeMap<String, String>,
    #[serde(default)]
    pub attributes: BTreeMap<String, String>,
    #[serde(default)]
    pub port_directions: BTreeMap<String, PortDirection>,
    #[serde(default)]
    pub connections: BTreeMap<String, Vec<YosysBit>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YosysNetname {
    #[serde(default)]
    pub hide_name: u8,
    #[serde(default)]
    pub bits: Vec<YosysBit>,
    #[serde(default)]
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, DeepSizeOf)]
#[serde(untagged)]
pub enum YosysBit {
    Net(u32),
    Const(String),
}

impl YosysBit {
    pub fn net(&self) -> Option<u32> {
        match self {
            Self::Net(bit) => Some(*bit),
            Self::Const(_) => None,
        }
    }

    pub fn const_value(&self) -> Option<&str> {
        match self {
            Self::Net(_) => None,
            Self::Const(value) => Some(value.as_str()),
        }
    }

    /// Yosys uses an unknown bit for an omitted cell input connection. It is
    /// not a structural driver and should not create a synthetic pin/edge.
    pub fn is_unconnected(&self) -> bool {
        matches!(self, Self::Const(value) if value.eq_ignore_ascii_case("x"))
    }
}

pub fn parse_value(value: Value) -> Result<YosysNetlist, NetlistError> {
    serde_json::from_value(value).map_err(NetlistError::Json)
}

pub fn parse_str(input: &str) -> Result<YosysNetlist, NetlistError> {
    serde_json::from_str(input).map_err(NetlistError::Json)
}

pub fn select_top<'a>(
    netlist: &'a YosysNetlist,
    requested: Option<&'a str>,
) -> Result<(&'a str, &'a YosysModule), NetlistError> {
    if let Some(top) = requested {
        let module = netlist
            .modules
            .get(top)
            .ok_or_else(|| NetlistError::TopNotFound(top.to_owned()))?;
        return Ok((top, module));
    }

    if let Some((name, module)) = netlist
        .modules
        .iter()
        .find(|(_, module)| attr_truthy(&module.attributes, "top"))
    {
        return Ok((name.as_str(), module));
    }

    let mut candidates = netlist
        .modules
        .iter()
        .filter(|(_, module)| !attr_truthy(&module.attributes, "blackbox"));
    let Some((name, module)) = candidates.next() else {
        return Err(NetlistError::NoTop);
    };
    if candidates.next().is_some() {
        return Err(NetlistError::AmbiguousTop);
    }
    Ok((name.as_str(), module))
}

pub fn module_blackboxes(netlist: &YosysNetlist) -> HashSet<String> {
    netlist
        .modules
        .iter()
        .filter(|(_, module)| attr_truthy(&module.attributes, "blackbox"))
        .map(|(name, _)| name.clone())
        .collect()
}

pub fn attr_truthy(attrs: &BTreeMap<String, String>, key: &str) -> bool {
    attrs
        .get(key)
        .is_some_and(|value| yosys_string_truthy(value))
}

pub fn yosys_string_truthy(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.chars().all(|ch| ch == '0' || ch == '1') {
        return trimmed.chars().any(|ch| ch == '1');
    }
    trimmed != "0" && !trimmed.eq_ignore_ascii_case("false")
}

pub fn binary_string_to_u64(value: &str) -> Option<u64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().all(|ch| ch == '0' || ch == '1') {
        u64::from_str_radix(trimmed, 2).ok()
    } else {
        trimmed.parse().ok()
    }
}
