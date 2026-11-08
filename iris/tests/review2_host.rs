//! review2: host shape edges. Synthetic values only.
use many_iris::cli_binding::{OwnedProfile, valid_host_id};

/// The CLI identity and binding rule (ASCII letters, digits, `-`, `_`, 1 to 128
/// bytes) has no `.`. Iris follows it exactly, so every dotted spelling is
/// refused here instead of being accepted and then refused by the CLI.
#[test]
fn r2_dot_edges_are_refused_like_the_cli() {
    for host in [
        ".",
        "..",
        "host.",
        ".host",
        "a..b",
        "lab-pc.local",
        "synthetic-host.",
    ] {
        assert!(!valid_host_id(host), "{host:?}");
        assert!(!OwnedProfile::RealBounded.admits_host(host), "{host:?}");
        assert!(!OwnedProfile::Synthetic.admits_host(host), "{host:?}");
    }
    // `-` and `_` alone are still inside the shared rule.
    for host in ["-", "_"] {
        assert!(valid_host_id(host), "{host:?}");
        assert!(OwnedProfile::RealBounded.admits_host(host), "{host:?}");
        assert!(!OwnedProfile::Synthetic.admits_host(host), "{host:?}");
    }
    for host in [
        "synthetic-host.",
        "Synthetic-host",
        "synthetic-host ",
        "synthetic_host",
    ] {
        assert!(!OwnedProfile::Synthetic.admits_host(host), "{host:?}");
    }
}
