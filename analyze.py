"""RoomSense analyzer: train on one round, test on the other. No random splits.

Usage:  python analyze.py              (train round 1, test round 2)
        python analyze.py --train 2 --test 1
"""
import argparse

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.metrics import ConfusionMatrixDisplay, accuracy_score, confusion_matrix
from sklearn.naive_bayes import GaussianNB
from sklearn.neighbors import KNeighborsClassifier
from sklearn.tree import DecisionTreeClassifier

ap = argparse.ArgumentParser()
ap.add_argument("--csv", default="scans.csv")
ap.add_argument("--train", type=int, default=1)
ap.add_argument("--test", type=int, default=2)
ap.add_argument("--min-seen", type=float, default=0.2, help="keep APs heard in at least this fraction of training scans")
ap.add_argument("--avg", type=int, default=5, help="scans averaged per prediction in the averaging test")
args = ap.parse_args()

df = pd.read_csv(args.csv)
df["sid"] = df["round"].astype(str) + "|" + df["zone"] + "|" + df["scan_id"].astype(str)
X = df.pivot_table(index="sid", columns="bssid", values="rssi", aggfunc="max").fillna(-100)
meta = df.drop_duplicates("sid").set_index("sid")[["round", "zone", "scan_id"]].loc[X.index]

tr = meta["round"] == args.train
te = meta["round"] == args.test
if tr.sum() == 0 or te.sum() == 0:
    raise SystemExit("Need data for both rounds. Rounds found: " + str(sorted(meta["round"].unique())))

keep = (X[tr] > -100).mean() >= args.min_seen
X = X.loc[:, keep]
print(f"Zones: {sorted(meta['zone'].unique())}")
print(f"Train scans: {int(tr.sum())}   Test scans: {int(te.sum())}   APs kept: {X.shape[1]}")
print(f"Median APs heard per scan: {int((X > -100).sum(axis=1).median())}\n")

Xtr, ytr = X[tr].values, meta.loc[tr, "zone"].values
Xte, yte = X[te].values, meta.loc[te, "zone"].values

models = {
    "kNN k=1": KNeighborsClassifier(1),
    "kNN k=3": KNeighborsClassifier(3),
    "kNN k=5": KNeighborsClassifier(5),
    "kNN k=5 distance-weighted": KNeighborsClassifier(5, weights="distance"),
    "Gaussian Naive Bayes": GaussianNB(var_smoothing=1e-1),
    "Decision tree": DecisionTreeClassifier(max_depth=8, random_state=0),
}

results = {}
for name, m in models.items():
    m.fit(Xtr, ytr)
    pred = m.predict(Xte)
    results[name] = (accuracy_score(yte, pred), pred)
    print(f"{name:28s} accuracy = {results[name][0] * 100:5.1f}%")

best = max(results, key=lambda k: results[k][0])
print(f"\nBest single-scan model: {best}")

labels = sorted(set(yte) | set(ytr))
cm = confusion_matrix(yte, results[best][1], labels=labels)
print("\nConfusion matrix (rows = true zone, columns = predicted):")
print(pd.DataFrame(cm, index=labels, columns=labels))
ConfusionMatrixDisplay(cm, display_labels=labels).plot(cmap="Blues", xticks_rotation=45)
plt.title(f"{best}: train round {args.train}, test round {args.test}")
plt.tight_layout()
plt.savefig("confusion.png", dpi=150)

print("\nPer-zone metrics:")
zone_warnings = []
for i, z in enumerate(labels):
    true_count = cm[i, :].sum()
    pred_count = cm[:, i].sum()
    correct = cm[i, i]
    recall = (correct / true_count * 100) if true_count > 0 else 0.0
    precision = (correct / pred_count * 100) if pred_count > 0 else 0.0
    print(f"  {z:10s}  recall: {recall:5.1f}% ({correct:2d}/{true_count:2d})   precision: {precision:5.1f}%")
    if recall < 60.0:
        zone_warnings.append(f"WARNING: Zone '{z}' recall is {recall:.1f}%, below the 60% floor!")

if zone_warnings:
    print()
    for w in zone_warnings:
        print(f"  [!] {w}")

# Averaging test: average `avg` consecutive test scans of the same zone, then predict once.
m = models[best]
Xa, ya = [], []
for z in labels:
    idx = meta[te & (meta["zone"] == z)].sort_values("scan_id").index
    vals = X.loc[idx].values
    for i in range(0, len(vals) - args.avg + 1, args.avg):
        Xa.append(vals[i:i + args.avg].mean(axis=0))
        ya.append(z)
if Xa:
    acc_avg = accuracy_score(ya, m.predict(np.array(Xa)))
    print(f"\n{best} with {args.avg} scans averaged per prediction: {acc_avg * 100:.1f}%  ({len(ya)} predictions)")

acc = results[best][0] * 100
print("\nVERDICT:")
if zone_warnings:
    print(f"WARNING / FLOOR BREACH: Overall accuracy is {acc:.1f}%, but {len(zone_warnings)} zone(s) failed the 60% recall floor.")
    print("Review confusion matrix for overlapping zones or multi-day drift before deploying.")
elif acc >= 70:
    print("GO. Fingerprints separate well enough. Continue with RoomSense.")
elif acc >= 50:
    print("BORDERLINE. Try: more scans averaged, a phone-hotspot anchor, fewer or farther-apart zones.")
else:
    print("WEAK. Check the confusion matrix for which zones merge; fix the zones or consider the Rhythm-Key fallback.")
print("Saved confusion.png")
