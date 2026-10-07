# Simulateur Git pédagogique

Un terminal pour s'entraîner à Git avec de vraies commandes. Au-dessus, un graphe de commits se
dessine en direct, avec une couleur par branche.
Le projet est écrit en HTML, CSS et JavaScript pur : pas de framework, pas de dépendance, rien à
installer ni à compiler.

## Essayer en ligne

**https://esteban-crln.github.io/git-train/**

Rien à télécharger : ouvrez le lien et tapez vos commandes dans le terminal. Tout se passe dans
votre navigateur, le simulateur ne touche pas à vos vrais fichiers.

## Lancer le simulateur sur son ordinateur

1. Récupérez le projet : `git clone https://github.com/esteban-crln/git-train.git`, puis entrez
   dans le dossier créé (`cd git-train`).
2. Démarrez un petit serveur web dans ce dossier :

   ```bash
   python -m http.server 8000
   ```

   (Sur Mac ou Linux, la commande peut être `python3` à la place de `python`.)
3. Ouvrez http://localhost:8000 dans votre navigateur.

Pourquoi un serveur, et pas un double-clic sur `index.html` ? Le code est découpé en plusieurs
fichiers JavaScript (des « modules ») que Chrome et Edge refusent de charger quand la page est
ouverte directement depuis le disque. Dans ce cas, la page affiche un message qui rappelle la
marche à suivre.

Python n'est qu'un exemple : n'importe quel serveur de fichiers convient, comme l'extension
« Live Server » de VS Code ou la commande `npx serve`.

## Arborescence

```
.
├── index.html       structure de la page, aide, message de secours
├── style.css        thème sombre, mise en page responsive, animations
├── README.md
└── js/
    ├── engine.js    moteur Git simulé (état JSON, commandes pures, pile d'annulation), sans DOM
    ├── remote.js    dépôt distant simulé : remote, fetch, push, pull, clone, collègue, merge request
    ├── rewrite.js   historique : reset, cherry-pick, revert, rebase (reprise après conflit)
    ├── stash.js     git stash (push, list, pop, apply, drop, show, branch, clear)
    ├── tags.js      git tag (légers et annotés)
    ├── parser.js    mini-shell : découpage de la saisie, options, sortie texte, explications
    ├── graph.js     rendu SVG du graphe (couleurs stables, étiquettes, HEAD, infobulles)
    ├── terminal.js  saisie, historique ↑/↓, autocomplétion Tab, affichage coloré
    └── main.js      assemblage, panneau des trois zones, sauvegarde localStorage
```

## Fonctionnalités

- **Commandes Git** : `init`, `status` (`-s`, `-b`), `add` (`<fichier>`, `.`, `-A`, `-f`), `commit`
  (`-m`, `-a`, `-am`, `--allow-empty`, `--amend`, `--no-edit`), `log` (`--oneline`, `--graph`,
  `--all`, `-n`, `-- <fichier>`, `--merge`), `branch` (liste, `-v`, création, `-d`, `-D`),
  `checkout` (`-b`, commit → HEAD détachée, `-- <fichier>`, `<commit> -- <fichier>`, `--ours`,
  `--theirs`), `switch` (`-c`, `--detach`, `-`), `merge` (avance rapide, commit de fusion,
  `--no-ff`, `--ff-only`, conflits avec `--abort`), `diff` (`--staged`, `<commit>`, `<a> <b>`,
  `<a>..<b>`, `<a>...<b>`, `--stat`, `--name-only`, `--name-status`), `config` (`user.name`,
  `user.email`, `pull.rebase`, `pull.ff`, `--list`), `help`.
- **Corriger et réécrire l'historique** : `restore` (`--staged`, `--worktree`, `--source=<commit>`,
  `--ours`, `--theirs`), `rm` (`--cached`, `-f`), `reset` (`--soft`, `--mixed`, `--hard`, `<fichier>`),
  `revert` (`-n`, `-m`, `--continue`, `--skip`, `--abort`), `cherry-pick` (`-x`, `-n`, `-m`, `a..b`,
  `--continue`, `--skip`, `--abort`), `rebase` (`<upstream>`, `<upstream> <branche>`, `--continue`,
  `--skip`, `--abort`, conflits commit par commit, commits déjà présents en amont ignorés),
  `stash` (`push`/`save`, `-u`, `-m`, `list`, `pop`, `apply`, `drop`, `clear`, `show [-p]`,
  `branch`), `tag` (légers et annotés, `-l`, `-n`, `-d`, `-f`), `check-ignore [-v]` et
  **`.gitignore`** (motifs `*`, `?`, `[…]`, `!`, `#`, à la racine : il n'y a pas de sous-dossiers).
- **Dépôt distant** : `clone`, `remote` (`-v`, `add`, `remove`), `fetch` (`--all`, `--prune`, tags
  récupérés automatiquement), `push` (`-u`, `-f`, `--force-with-lease`, `--delete`, `--tags`,
  `<tag>`, refus « fetch first » / « non-fast-forward » / « stale info » / « already exists »),
  `pull` (`--no-rebase`, `--rebase`, `--ff-only`, `pull.rebase true`, refus des branches
  divergentes comme Git ≥ 2.34), branches de suivi `origin/…`, `branch -r`, `-a`, `-vv`, `-u`,
  `--unset-upstream`, `checkout <branche distante>` qui crée la branche locale suivie, avance et
  retard dans `git status`.
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
  `index`, `merge`, `pick` et `rebase` (opération arrêtée sur un conflit, avec de quoi la reprendre
  ou l'annuler), `tags` et `tagMeta` (tags annotés), `stash` (pile), `remotes`, `remoteRefs`
  (branches de suivi) et `upstreams` (branche suivie par chaque branche locale). `servers` contient
  les dépôts distants, indexés par URL, avec leurs branches et leurs tags : c'est la forge
  simulée. L'état est validé au chargement : une sauvegarde corrompue est ignorée, et une
  sauvegarde d'une version précédente est complétée.
- Chaque commande du moteur reçoit un état et renvoie `{ state, out, ok, info }` sans modifier
  l'état reçu. L'horloge et le hasard sont injectables (`env`), ce qui rend le moteur testable
  hors navigateur. `parser.execute` intercepte toute exception : une commande invalide ne peut
  pas corrompre l'état.
- **Rejouer des commits** : `rebase`, `cherry-pick` et `revert` partagent la fusion à trois voies de
  `git merge` (`mergeTrees3` et `writeMerge` dans `engine.js`). Un rebase détache HEAD, rejoue les
  commits un par un (même message, même auteur, même date, nouveau hash) et ne déplace la branche
  qu'à la fin ; les anciens commits deviennent orphelins, donc transparents dans le graphe. Sur
  un conflit, l'opération est mémorisée dans `repo.rebase` ou `repo.pick`, et `status`, `add`,
  `commit`, `log --merge` et `checkout --ours/--theirs` s'appuient sur `conflictsOf(repo)`.
- **Écarts connus avec Git** : un conflit au `stash pop` écrit les marqueurs dans le fichier mais le
  laisse « modifié » dans `git status` (Git le déclare « unmerged ») ; `rebase -i`, `rebase --onto`,
  `stash -p` et `stash --index` demandent un éditeur ou un mode interactif et ne sont pas simulés ;
  un cherry-pick ou un revert devenu vide annule l'opération au lieu de la laisser en cours.
- Pour ajouter une commande : écrire la fonction dans `engine.js` (ou `remote.js`, `rewrite.js`,
  `stash.js`, `tags.js`), puis la déclarer dans le registre `GIT` de `parser.js`.

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

## Scénario de test : mettre sa branche à jour avec `rebase`

Même point de départ, mais cette fois la collègue pousse sur `main` pendant que vous travaillez, et
vous gardez un historique linéaire au lieu d'un commit de fusion.

```bash
git clone https://github.com/camille/demo.git
git switch -c ma-feature
echo "A" > a.txt
git add .
git commit -m "ajoute a"
echo "B" > b.txt
git add .
git commit -m "ajoute b"
git push -u origin ma-feature
collab main
git fetch
git rebase origin/main
git push
git push --force-with-lease
```

Résultat attendu : `git rebase` affiche `Successfully rebased and updated refs/heads/ma-feature.` ;
dans le graphe, deux **nouveaux** commits (« ajoute a », « ajoute b ») apparaissent après le commit
de la collègue, et les deux anciens, encore pointés par `origin/ma-feature`, restent à côté ;
`git status` annonce `have diverged` ; le premier `git push` est refusé (`non-fast-forward`) et
l'explication propose `--force-with-lease`, qui passe.

Pour provoquer un conflit, remplacez `collab main` par `collab main a.txt` : la collègue crée alors
elle aussi un fichier `a.txt` sur `main`, avec un autre contenu que le vôtre. Le rebase s'arrête sur
votre commit « ajoute a » (`git status` affiche `interactive rebase in progress`). Pour continuer :

1. corrigez le fichier, avec `echo "…" > a.txt` ou `git checkout --theirs a.txt` ;
2. `git add a.txt` ;
3. `git rebase --continue`.

`git rebase --abort` annule tout et remet la branche comme avant le rebase.
