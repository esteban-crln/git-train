# Simulateur Git pédagogique

Un terminal pour s'entraîner à Git avec de vraies commandes, et au-dessus un graphe de commits
qui se construit en direct, avec une couleur par branche.
HTML, CSS et JavaScript pur : aucun framework, aucune dépendance, aucune étape de compilation.

## Lancer le simulateur

Le code est découpé en modules ES (`<script type="module">`). Chrome et Edge refusent de charger
des modules depuis une page ouverte par double-clic (adresse `file://`). Dans ce cas, la page
affiche un message qui explique quoi faire. Il suffit de servir le dossier :

```bash
python3 -m http.server 8000   # puis ouvrir http://localhost:8000
```

N'importe quel serveur statique convient (extension « Live Server » de VS Code, `npx serve`,
GitHub Pages…).

## Arborescence

```
.
├── index.html       structure de la page, aide, message de secours
├── style.css        thème sombre, mise en page responsive, animations
├── README.md
└── js/
    ├── engine.js    moteur Git simulé (état JSON, commandes pures, pile d'annulation), sans DOM
    ├── remote.js    dépôt distant simulé : remote, fetch, push, pull, clone, collègue, merge request
    ├── parser.js    mini-shell : découpage de la saisie, options, sortie texte, explications
    ├── graph.js     rendu SVG du graphe (couleurs stables, étiquettes, HEAD, infobulles)
    ├── terminal.js  saisie, historique ↑/↓, autocomplétion Tab, affichage coloré
    └── main.js      assemblage, panneau des trois zones, sauvegarde localStorage
```

## Fonctionnalités

- **Commandes Git** : `init`, `status` (`-s`, `-b`), `add` (`<fichier>`, `.`, `-A`), `commit`
  (`-m`, `-a`, `-am`, `--allow-empty`), `log` (`--oneline`, `--graph`, `--all`, `-n`), `branch`
  (liste, `-v`, création, `-d`, `-D`), `checkout` (`-b`, commit → HEAD détachée, `-- <fichier>`),
  `switch` (`-c`, `--detach`, `-`), `merge` (avance rapide, commit de fusion, `--no-ff`,
  `--ff-only`, conflits avec `--abort`), `diff` (`--staged`), `config` (`user.name`, `user.email`,
  `pull.rebase`, `pull.ff`, `--list`), `help`.
- **Dépôt distant** : `clone`, `remote` (`-v`, `add`, `remove`), `fetch` (`--all`, `--prune`),
  `push` (`-u`, `-f`, `--delete`, refus « fetch first » / « non-fast-forward »), `pull`
  (`--no-rebase`, `--ff-only`, refus des branches divergentes comme Git ≥ 2.34), branches de suivi
  `origin/…`, `branch -r`, `-a`, `-vv`, `-u`, `--unset-upstream`, `checkout <branche distante>` qui
  crée la branche locale suivie, avance et retard dans `git status`.
- **Forge simulée** : un dépôt de démonstration (`git clone https://github.com/camille/demo.git`) ;
  toute autre URL donnée à `git remote add` crée un dépôt distant vide. Deux commandes
  pédagogiques : `collab [branche] [fichier]` (une collègue pousse un commit) et
  `mr <branche> [cible]` (la merge request est acceptée sur la forge, avec un commit de fusion).
  Les formes abrégées du cours (`git push main`, `git remote add <url>`) reçoivent l'erreur de Git
  suivie de la forme complète.
- **Fichiers simulés** : `touch`, `echo "texte" > f`, `echo "texte" >> f`, `cat`, `ls [-a]`, `rm`,
  `clear`, `help`. Les commandes s'enchaînent avec `&&` ou `;`, et `*` est développé.
- Les **messages reprennent ceux de Git** (`nothing to commit, working tree clean`,
  `error: pathspec 'x' did not match any file(s) known to git`, conseils sur la HEAD détachée,
  marqueurs de conflit…). Une faute de frappe (`git comit`) déclenche la suggestion de Git ;
  toute autre commande répond « Commande non supportée dans ce simulateur. »
- Après chaque commande Git, une **phrase en italique** explique ce qui vient de se passer.
- **Graphe** : temps de gauche à droite, une ligne par branche ; 10 couleurs, attribuées une fois
  pour toutes à la création de la branche. Étiquettes de branches au-dessus du commit pointé,
  marqueur HEAD, animation d'apparition (300 ms), infobulle (hash, message, auteur, date),
  clic sur un commit pour insérer son hash dans le terminal. Les commits devenus inaccessibles
  restent affichés en transparence.
- **Panneau « Zones Git »** (replié au départ) : répertoire de travail, staging area, dépôt local
  (avec l'avance ↑ et le retard ↓ de chaque branche sur sa branche distante) et dépôt distant.
- Dans le graphe, les **branches de suivi** (`origin/main`…) ont une étiquette en pointillé.
- **Annuler la dernière commande** (pile de 50 états), **Réinitialiser**, **Aide**.
- **Sauvegarde automatique** dans le `localStorage` (état, pile d'annulation, historique).

## Architecture

- L'état est un objet JSON : `workdir`, et `repo` avec `commits` (id court, hash, message,
  parents, auteur, horodatage, arbre de fichiers), `branches`, `head` (rattachée ou détachée),
  `index`, `merge` (fusion en cours), `remotes`, `remoteRefs` (branches de suivi) et `upstreams`
  (branche suivie par chaque branche locale). `servers` contient les dépôts distants, indexés par
  URL : c'est la forge simulée. L'état est validé au chargement : une sauvegarde corrompue est
  ignorée, et une sauvegarde d'une version précédente est complétée.
- Chaque commande du moteur reçoit un état et renvoie `{ state, out, ok, info }` sans modifier
  l'état reçu. L'horloge et le hasard sont injectables (`env`), ce qui rend le moteur testable
  hors navigateur. `parser.execute` intercepte toute exception : une commande invalide ne peut
  pas corrompre l'état.
- **Commandes prévues** : `reset`, `revert`, `cherry-pick`, `stash`, `tag`, `rebase`. Elles sont
  déclarées dans `PLANNED_COMMANDS`, l'état réserve déjà `tags` et `stash`, et le graphe sait
  afficher des étiquettes de tag. Pour en ajouter une : écrire la fonction dans `engine.js` (ou
  `remote.js`), puis la déclarer dans le registre `GIT` de `parser.js`.

## Scénario de test (10 commandes)

Ce scénario vérifie la coloration du graphe avec deux branches et un commit de fusion.
Partez d'un simulateur vierge (bouton « Réinitialiser »), puis tapez :

```bash
git init
touch README.md notes.txt
git add .
git commit -m "Premier commit"
git switch -c feature
echo "Nouvelle fonctionnalité" > README.md
git commit -am "Ajoute la fonctionnalité"
git switch main
git commit --allow-empty -m "Correctif sur main"
git merge feature
```

`--allow-empty` crée un commit sans modification. Il fait diverger `main` en une seule commande
pour que la fusion produise un vrai commit de fusion, et non une avance rapide.

Résultat attendu :

| Élément | Attendu |
| --- | --- |
| Ligne `main` (bleu `#58a6ff`) | 3 commits : « Premier commit », « Correctif sur main », puis le commit de fusion (cercle avec un point central) |
| Ligne `feature` (rose `#f778ba`) | 1 commit : « Ajoute la fonctionnalité » |
| Traits | Une bifurcation rose de « Premier commit » vers `feature`, et un trait rose de `feature` vers le commit de fusion, qui a donc deux parents |
| Étiquettes | `HEAD` et `main` (bleue, bordure blanche) sur le commit de fusion ; `feature` (rose) sur son commit |
| Terminal | `Merge made by the 'ort' strategy.` puis ` README.md \| 1 +`, et l'invite `~/projet (main) $` |

Pour aller plus loin : `git log --oneline --graph --all` dessine le même historique en ASCII,
comme le vrai Git ; le bouton « Annuler » retire le commit de fusion et l'étiquette `main` revient
en glissant sur « Correctif sur main ».

## Scénario de test : travail en équipe avec le dépôt distant

Ce scénario suit le « workflow fondamental » d'un cours Git classique : cloner, créer une branche
de fonctionnalité, la pousser, faire accepter la merge request, puis mettre `main` à jour.

```bash
git clone https://github.com/camille/demo.git
git switch -c feat/contact
echo "Page contact" > contact.txt
git add .
git commit -m "Ajoute la page contact"
git push -u origin feat/contact
mr feat/contact
git switch main
git pull
git log --oneline --graph --all
```

Résultat attendu : `git push -u` affiche ` * [new branch]      feat/contact -> feat/contact` puis
`branch 'feat/contact' set up to track 'origin/feat/contact'.` ; après `mr`, la zone 4 du panneau
signale des nouveautés sur `main` ; `git pull` récupère le commit de fusion
(`Merge branch 'feat/contact' into 'main'`) en avance rapide. Dans le graphe, `main` et
`origin/main` pointent sur ce commit de fusion, qui reçoit un trait vert depuis `feat/contact`.

Pour provoquer un push refusé : `collab`, puis un commit local, puis `git push` (« rejected …
fetch first ») ; `git pull --no-rebase` fusionne, et `git push` passe.
