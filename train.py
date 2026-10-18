"""RoomSense Laptop Trainer & Evaluator
Leave-One-Session-Out Cross Validation for Weighted kNN and Gaussian Naive Bayes
Implemented with plain NumPy to guarantee bit-for-bit parity with browser JS runtime.
"""

import argparse
import sys
import numpy as np
import pandas as pd


def load_dataset(csv_path):
    """Load survey.csv or legacy scans.csv, normalize BSSIDs and pivot to RSSI matrix."""
    df = pd.read_csv(csv_path)

    # Normalize column names across pilot and production formats
    if "round" in df.columns and "session" not in df.columns:
        df["session"] = "round_" + df["round"].astype(str)

    required_cols = {"session", "zone", "scan_id", "bssid", "rssi"}
    missing = required_cols - set(df.columns)
    if missing:
        raise ValueError(f"CSV missing required columns: {missing}")

    # Normalize BSSID: strip colons, dashes, and convert to lowercase 12-char hex
    df["bssid"] = (
        df["bssid"]
        .astype(str)
        .str.replace(":", "", regex=False)
        .str.replace("-", "", regex=False)
        .str.lower()
    )

    # Create unique scan identifier
    df["sid"] = df["session"] + "|" + df["zone"] + "|" + df["scan_id"].astype(str)

    # Pivot: rows = unique scans, columns = unique BSSIDs, values = max RSSI, fillna -100 dBm
    pivot = df.pivot_table(index="sid", columns="bssid", values="rssi", aggfunc="max").fillna(-100.0)
    meta = df.drop_duplicates("sid").set_index("sid").loc[pivot.index, ["session", "zone", "scan_id"]]

    return pivot, meta


class NumPyGaussianNB:
    """Gaussian Naive Bayes implemented in pure NumPy with explicit variance smoothing."""

    def __init__(self, var_smoothing=0.1):
        self.var_smoothing = float(var_smoothing)
        self.classes_ = None
        self.priors_ = None
        self.means_ = None
        self.variances_ = None

    def fit(self, X, y):
        self.classes_ = np.unique(y)
        n_samples, n_features = X.shape
        n_classes = len(self.classes_)

        self.priors_ = np.zeros(n_classes, dtype=np.float64)
        self.means_ = np.zeros((n_classes, n_features), dtype=np.float64)
        self.variances_ = np.zeros((n_classes, n_features), dtype=np.float64)

        for idx, c in enumerate(self.classes_):
            X_c = X[y == c]
            self.priors_[idx] = len(X_c) / n_samples
            self.means_[idx] = X_c.mean(axis=0)
            self.variances_[idx] = X_c.var(axis=0) + self.var_smoothing

        return self

    def predict_log_proba(self, X):
        # Shape: (n_samples, n_classes)
        log_priors = np.log(self.priors_)
        log_probs = []

        # Gaussian log likelihood: -0.5 * sum( ln(2*pi*var) + (x - mu)^2 / var )
        for x in X:
            ll = -0.5 * np.sum(
                np.log(2.0 * np.pi * self.variances_) + ((x - self.means_) ** 2) / self.variances_,
                axis=1,
            )
            log_probs.append(log_priors + ll)

        return np.array(log_probs)

    def predict_proba(self, X):
        log_probs = self.predict_log_proba(X)
        # Numerically stable softmax
        max_log = np.max(log_probs, axis=1, keepdims=True)
        exp_probs = np.exp(log_probs - max_log)
        return exp_probs / np.sum(exp_probs, axis=1, keepdims=True)

    def predict(self, X):
        probs = self.predict_proba(X)
        return self.classes_[np.argmax(probs, axis=1)]


class NumPyWeightedKNN:
    """Distance-Weighted k-Nearest Neighbors in pure NumPy."""

    def __init__(self, k=3, eps=1e-5):
        self.k = int(k)
        self.eps = float(eps)
        self.classes_ = None
        self.X_train_ = None
        self.y_train_ = None

    def fit(self, X, y):
        self.classes_ = np.unique(y)
        self.X_train_ = np.array(X, dtype=np.float64)
        self.y_train_ = np.array(y)
        return self

    def predict_proba(self, X):
        n_samples = len(X)
        probs = np.zeros((n_samples, len(self.classes_)), dtype=np.float64)
        class_to_idx = {c: i for i, c in enumerate(self.classes_)}

        for sample_idx, x in enumerate(X):
            # Euclidean distance to all training vectors
            dists = np.sqrt(np.sum((self.X_train_ - x) ** 2, axis=1))
            k_indices = np.argsort(dists)[: self.k]
            k_dists = dists[k_indices]
            k_labels = self.y_train_[k_indices]

            weights = 1.0 / (k_dists + self.eps)
            for lbl, w in zip(k_labels, weights):
                probs[sample_idx, class_to_idx[lbl]] += w

            total_w = np.sum(probs[sample_idx])
            if total_w > 0:
                probs[sample_idx] /= total_w
            else:
                probs[sample_idx] = 1.0 / len(self.classes_)

        return probs

    def predict(self, X):
        probs = self.predict_proba(X)
        return self.classes_[np.argmax(probs, axis=1)]


def evaluate_predictions(y_true, y_pred, labels):
    """Compute accuracy, confusion matrix, and per-zone precision/recall table."""
    acc = np.mean(y_true == y_pred)
    cm = pd.DataFrame(0, index=labels, columns=labels)
    for t, p in zip(y_true, y_pred):
        if t in cm.index and p in cm.columns:
            cm.loc[t, p] += 1

    per_zone = {}
    warnings = []
    for z in labels:
        actual = (y_true == z).sum()
        predicted = (y_pred == z).sum()
        correct = ((y_true == z) & (y_pred == z)).sum()
        recall = (correct / actual * 100.0) if actual > 0 else 0.0
        precision = (correct / predicted * 100.0) if predicted > 0 else 0.0
        per_zone[z] = {
            "actual": actual,
            "correct": correct,
            "recall": recall,
            "precision": precision,
        }
        if actual > 0 and recall < 60.0:
            warnings.append(f"Zone '{z}' recall is {recall:.1f}%, below the 60% floor!")

    return acc, cm, per_zone, warnings


def print_evaluation_report(title, acc, cm, per_zone, warnings):
    """Pretty-print evaluation metrics, confusion matrix, and floor checks."""
    print(f"\n{'=' * 65}")
    print(f" {title.upper()} ")
    print(f"{'=' * 65}")
    print(f"Overall Accuracy: {acc * 100:.1f}%\n")
    print("Confusion Matrix (rows = actual, columns = predicted):")
    print(cm)
    print("\nPer-Zone Performance:")
    for z, m in per_zone.items():
        print(
            f"  {z:10s}  recall: {m['recall']:5.1f}% ({m['correct']:2d}/{m['actual']:2d})   "
            f"precision: {m['precision']:5.1f}%"
        )

    if warnings:
        print()
        for w in warnings:
            print(f"  [!] WARNING: {w}")
        print("\nVERDICT: FLOOR BREACH — One or more zones scored below the 60% recall floor.")
    else:
        print(f"\nVERDICT: PASS — All zones met or exceeded the 60% recall floor.")


def run_evaluation(csv_path, holdout=None, min_seen=0.2, k=3, var_smoothing=0.1):
    """Run Leave-One-Session-Out Cross Validation or single holdout evaluation."""
    pivot, meta = load_dataset(csv_path)
    sessions = sorted(meta["session"].unique())
    all_zones = sorted(meta["zone"].unique())

    print(f"Loaded dataset: '{csv_path}'")
    print(f"Sessions ({len(sessions)}): {sessions}")
    print(f"Zones ({len(all_zones)}): {all_zones}")
    print(f"Total scans: {len(pivot)}, Total unique APs heard: {pivot.shape[1]}")

    if holdout is not None:
        if holdout not in sessions:
            raise ValueError(f"Holdout session '{holdout}' not found in sessions: {sessions}")
        eval_sessions = [holdout]
    else:
        if len(sessions) < 2:
            print(f"\n[NOTE] Only 1 session ('{sessions[0]}') present in {csv_path}.")
            print("Leave-One-Session-Out Cross Validation requires at least 2 sessions.")
            print("Running within-session Stratified 5-Fold validation as a preliminary health check...\n")
            from sklearn.model_selection import StratifiedKFold
            skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
            X = pivot.values
            y = meta["zone"].values
            knn_preds = np.empty_like(y)
            gnb_preds = np.empty_like(y)
            for tr_idx, te_idx in skf.split(X, y):
                knn = NumPyWeightedKNN(k=k).fit(X[tr_idx], y[tr_idx])
                gnb = NumPyGaussianNB(var_smoothing=var_smoothing).fit(X[tr_idx], y[tr_idx])
                knn_preds[te_idx] = knn.predict(X[te_idx])
                gnb_preds[te_idx] = gnb.predict(X[te_idx])

            acc_k, cm_k, pz_k, w_k = evaluate_predictions(y, knn_preds, all_zones)
            print_evaluation_report(f"Session 1 (5-Fold CV) — Weighted kNN (k={k})", acc_k, cm_k, pz_k, w_k)

            acc_g, cm_g, pz_g, w_g = evaluate_predictions(y, gnb_preds, all_zones)
            print_evaluation_report(f"Session 1 (5-Fold CV) — Gaussian Naive Bayes (smooth={var_smoothing})", acc_g, cm_g, pz_g, w_g)
            return

        eval_sessions = sessions

    # Evaluate across held-out sessions
    for held_out in eval_sessions:
        tr_mask = meta["session"] != held_out
        te_mask = meta["session"] == held_out

        # Feature selection: keep APs heard in >= min_seen fraction of training scans
        train_pivot = pivot.loc[tr_mask]
        keep_aps = (train_pivot > -100.0).mean(axis=0) >= min_seen
        kept_ap_list = pivot.columns[keep_aps].tolist()

        X_tr = pivot.loc[tr_mask, keep_aps].values
        y_tr = meta.loc[tr_mask, "zone"].values
        X_te = pivot.loc[te_mask, keep_aps].values
        y_te = meta.loc[te_mask, "zone"].values

        print(f"\n{'#' * 65}")
        print(f" EVALUATION: HELD-OUT SESSION '{held_out}' ")
        print(f" Train scans: {len(X_tr)} | Test scans: {len(X_te)} | APs kept: {len(kept_ap_list)} (min_seen={min_seen})")
        print(f"{'#' * 65}")

        # Model 1: Weighted kNN
        knn = NumPyWeightedKNN(k=k).fit(X_tr, y_tr)
        knn_pred = knn.predict(X_te)
        acc_k, cm_k, pz_k, w_k = evaluate_predictions(y_te, knn_pred, all_zones)
        print_evaluation_report(f"Weighted kNN (k={k}) [Holdout: {held_out}]", acc_k, cm_k, pz_k, w_k)

        # Model 2: Gaussian Naive Bayes
        gnb = NumPyGaussianNB(var_smoothing=var_smoothing).fit(X_tr, y_tr)
        gnb_pred = gnb.predict(X_te)
        acc_g, cm_g, pz_g, w_g = evaluate_predictions(y_te, gnb_pred, all_zones)
        print_evaluation_report(f"Gaussian Naive Bayes (smooth={var_smoothing}) [Holdout: {held_out}]", acc_g, cm_g, pz_g, w_g)


def main():
    parser = argparse.ArgumentParser(description="RoomSense Laptop ML Trainer & Evaluator")
    parser.add_argument("--csv", default="survey.csv", help="Input CSV path (default: survey.csv)")
    parser.add_argument("--holdout", default=None, help="Specific session to hold out (default: all sessions)")
    parser.add_argument("--min-seen", type=float, default=0.2, help="AP appearance threshold in train set (default: 0.2)")
    parser.add_argument("--k", type=int, default=3, help="k for Weighted kNN (default: 3)")
    parser.add_argument("--var-smoothing", type=float, default=0.1, help="Variance floor smoothing for Gaussian NB (default: 0.1)")
    args = parser.parse_args()

    run_evaluation(
        csv_path=args.csv,
        holdout=args.holdout,
        min_seen=args.min_seen,
        k=args.k,
        var_smoothing=args.var_smoothing,
    )


if __name__ == "__main__":
    main()
