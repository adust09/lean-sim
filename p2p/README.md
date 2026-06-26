# P2P レイヤー シミュレータ（node/networking/）

leanEthereum/leanSpec の Python リファレンス実装 `src/lean_spec/node/networking/` を、
ブラウザ上でインタラクティブに動かして直感的に理解するためのシミュレータです。
[lean-sim](../) コレクションの一部で、`../shared/` の core（描画・UI ヘルパ）と
汎用シェルを共有しています。

## 起動方法

ルートの [README](../README.md) 参照。最も簡単なのはリポジトリ直下で:

```bash
python3 -m http.server 8000
# http://localhost:8000/p2p/ を開く
```

特定のシーンへ直接飛ぶには URL ハッシュを使います:
`…/p2p/#layers` / `#gossipsub` / `#discovery` / `#quic` / `#reqresp` / `#lifecycle`

## 6つのシーン（実装モジュールに対応）

| タブ | 実装 | 可視化する内容 |
| --- | --- | --- |
| レイヤー分離 | `gossipsub/` + `5.1.3` | committee / subnet / topic / peer を別レイヤーとして縦に積んで分離。subnet N ≡ topic `attestation_N`、mesh は固定の 50〜100 物理ピアの部分集合。topic を購読/解除しても物理接続は一定。64 subnet で 1M validator を捌ける時間スライス（瞬間≈488 / エポック累計≈15,625）も併示 |
| Discovery v5 | `enr/` (discv5: 予定) | XOR 距離と反復探索（漏斗状の収束）、k-bucket。**現行 leanSpec はピア発見を ENR 解決の静的ブートストラップで行い discv5 は将来予定**。本シーンは将来機構の可視化 |
| QUIC トランスポート | `transport/quic/` | Head-of-Line ブロッキング比較、接続確立の RTT（1-RTT、0-RTT は無効）。libp2p TLS(ALPN "libp2p" / OID 拡張)。QUIC が唯一のトランスポート |
| Gossipsub 伝播 | `gossipsub/` | mesh の eager push、IHAVE/IWANT の lazy pull、heartbeat の GRAFT/PRUNE、重複排除。v1.2(/meshsub/1.2.0)、D=8/6/12 |
| Request-Response | `reqresp/` | Status ハンドシェイク(finalized+head Checkpoint、fork digest なし)、blocks_by_range、ストリームの非対称クローズ、空きスロット省略とチェーン再構築 |
| ライフサイクル | `node/networking/` | 新規ノードの一生(発見→接続→ハンドシェイク→同期→購読/GRAFT→稼働)を1シナリオで横断。シナリオ(正常/フォーク混在/高チャーン)とトピック(block/subnet)を切替 |

各シーンの右サイドバーに「コントロール」「統計」「解説」があります。
まず解説を読み、コントロールで操作しながら統計の変化を観察してください。

## 構成

```
p2p/
├── index.html            # タブ + キャンバス + サイドバー
└── js/scenes/
    ├── layers.js         # committee/subnet/topic/peer の層分離（§5.1.3）
    ├── discovery.js      # enr/ (discv5: 予定)
    ├── quic.js           # transport/quic/
    ├── gossipsub.js      # gossipsub/
    ├── reqresp.js        # reqresp/
    └── lifecycle.js      # node/networking/ 総まとめ（新規ノードの一生）

../shared/                # コレクション共有
├── core.js               #   ユーティリティ・描画ヘルパ・UIファクトリ（P2P.scenes 登録先）
├── app.js                #   汎用シェル（タブ・描画ループ・統計パネル）
└── style.css
```

新しいシーンは `js/scenes/` に
`init / resize / update / render / onMouse / getStats / buildControls` と
`title / sectionRef / descriptionHTML` を実装したオブジェクトを `P2P.scenes` に登録し、
`index.html` に `<script>` を追加、`window.P2P_SCENE_ORDER` に id を足すだけで増やせます。
