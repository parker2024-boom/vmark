# Génies IA

Les Génies IA sont des modèles d'invite qui transforment votre texte à l'aide de l'IA. Sélectionnez du texte, invoquez un génie et examinez les modifications suggérées — sans jamais quitter l'éditeur.

## Démarrage rapide

1. Configurez un fournisseur d'IA dans **Paramètres > Intégrations** (voir [Fournisseurs d'IA](/fr/guide/ai-providers))
2. Sélectionnez du texte dans l'éditeur
3. Appuyez sur `Mod + Y` pour ouvrir le sélecteur de génie
4. Choisissez un génie ou tapez une invite libre
5. Examinez la suggestion en ligne — acceptez ou refusez

## Le sélecteur de génie

Appuyez sur `Mod + Y` (ou menu **Édition → Génies → Rechercher des génies…**) pour ouvrir une superposition de style Spotlight avec une seule entrée unifiée. Le même sous-menu liste chaque génie par son nom&nbsp;; un génie peut donc aussi être lancé directement depuis le menu.

**Recherche et formulaire libre** — Commencez à taper pour filtrer les génies par nom, description ou catégorie. Si aucun génie ne correspond, l'entrée devient un champ d'invite libre.

**Puces rapides** — Quand la portée est « sélection » et que l'entrée est vide, des boutons en un clic apparaissent pour les actions courantes (Peaufiner, Condenser, Grammaire, Reformuler).

**Formulaire libre en deux étapes** — Quand aucun génie ne correspond, appuyez sur `Entrée` une première fois pour voir un message de confirmation, puis `Entrée` à nouveau pour soumettre comme invite IA. Cela évite les soumissions accidentelles.

**Cycle de portée** — Appuyez sur `Tab` pour parcourir les portées : sélection → bloc → document → tout.

**Historique des invites** — En mode formulaire libre (aucun génie correspondant), appuyez sur `Flèche Haut` / `Flèche Bas` pour parcourir les invites précédentes. Appuyez sur `Ctrl + R` pour ouvrir un menu déroulant d'historique consultable ; son bouton **Effacer l'historique** vide d'un coup l'historique enregistré (jusqu'à 100 invites), sans demander de confirmation. Le texte fantôme affiche l'invite correspondante la plus récente sous forme d'indice grisé — appuyez sur `Tab` pour l'accepter, ou sur `Échap` pour l'ignorer (il réapparaît dès que vous modifiez ce que vous avez tapé).

### Retour de traitement

Après avoir sélectionné un génie ou soumis une invite libre, le sélecteur affiche un retour en ligne :

- **Traitement** — Un indicateur de réflexion avec un compteur de temps écoulé. Appuyez sur `Échap` pour annuler.
- **Aperçu** — La réponse de l'IA apparaît au fur et à mesure qu'elle arrive&nbsp;: les fournisseurs CLI la diffusent pendant sa génération, tandis que les fournisseurs REST livrent la réponse entière d'un seul coup à la fin de la requête. Utilisez `Accepter` pour appliquer ou `Rejeter` pour ignorer.
- **Erreur** — En cas de problème, le message d'erreur apparaît avec un bouton `Réessayer`.

La barre d'état affiche également la progression de l'IA — une icône tournante avec le temps écoulé pendant l'exécution, un bref flash « Terminé » en cas de succès, ou un indicateur d'erreur avec des boutons **Réessayer** et **Ignorer**. **Réessayer** relance la requête en échec — le même génie ou la même invite, sur la sélection actuelle — même après la fermeture du sélecteur ; le bouton est absent quand il n'y a rien à relancer, par exemple sans fournisseur. La barre d'état s'affiche automatiquement quand l'IA a un statut actif, même si vous l'avez précédemment masquée avec `F7`.

## Génies intégrés

VMark est livré avec 13 génies répartis en quatre catégories :

### Édition

| Génie | Description | Portée |
|-------|-------------|--------|
| Peaufiner | Améliorer la clarté et le flux | Sélection |
| Condenser | Rendre le texte plus concis | Sélection |
| Corriger la grammaire | Corriger la grammaire et l'orthographe | Sélection |
| Simplifier | Utiliser un langage plus simple | Sélection |

### Créatif

| Génie | Description | Portée |
|-------|-------------|--------|
| Développer | Développer l'idée en prose plus complète | Sélection |
| Reformuler | Dire la même chose différemment | Sélection |
| Vivant | Ajouter des détails sensoriels et des images | Sélection |
| Continuer | Continuer l'écriture depuis ici | Bloc |

### Structure

| Génie | Description | Portée |
|-------|-------------|--------|
| Résumer | Résumer le document | Document |
| Plan | Générer un plan | Document |
| Titre | Suggérer des options de titre | Document |

### Outils

| Génie | Description | Portée |
|-------|-------------|--------|
| Traduire | Traduire en anglais | Sélection |
| Réécrire en anglais | Réécrire le texte en anglais | Sélection |

## Portée

Chaque génie opère sur l'une des trois portées suivantes :

- **Sélection** — Le texte surligné. Si rien n'est sélectionné, utilise le bloc actuel.
- **Bloc** — Le paragraphe ou l'élément de bloc à la position du curseur.
- **Document** — Le contenu complet du document.

La portée détermine quel texte est extrait et transmis à l'IA comme `{{content}}`.

::: tip
Si la portée est **Sélection** mais que rien n'est sélectionné, le génie opère sur le paragraphe actuel.
:::

## Examiner les suggestions

Après l'exécution d'un génie, la suggestion apparaît en ligne :

- **Remplacement** — Texte original barré d'un trait ondulé rouge, suivi du nouveau texte en texte « fantôme » italique estompé, dans la couleur d'accent
- **Insertion** — Nouveau texte affiché en texte fantôme après le bloc source
- **Suppression** — Texte original barré d'un trait ondulé rouge

Chaque suggestion a des boutons d'acceptation (coche) et de rejet (X).

### Raccourcis clavier

| Action | Raccourci |
|--------|----------|
| Accepter la suggestion | `Entrée` |
| Rejeter la suggestion | `Échap` |
| Suggestion suivante | `Tab` |
| Suggestion précédente | `Shift + Tab` |
| Tout accepter | `Mod + Shift + Entrée` |
| Tout rejeter | `Mod + Shift + Échap` |

## Indicateur de la barre d'état

Pendant la génération par l'IA, la barre d'état affiche une icône d'éclat tournante avec un compteur de temps écoulé (« Réflexion... 3s »). Un bouton d'annulation (×) vous permet d'arrêter la requête.

Après la complétion, une brève coche « Terminé » clignote pendant 3 secondes. En cas d'erreur, la barre d'état affiche le message d'erreur avec les boutons Réessayer et Ignorer.

La barre d'état s'affiche automatiquement quand l'IA a un statut actif (en cours, erreur ou succès), même si vous l'avez masquée avec `F7`.

---

## Écrire des génies personnalisés

Vous pouvez créer vos propres génies. Chaque génie est un fichier Markdown unique avec des métadonnées YAML et un modèle d'invite.

### Où les génies sont stockés

Les génies sont stockés dans votre répertoire de données d'application :

| Plateforme | Chemin |
|------------|--------|
| macOS | `~/Library/Application Support/app.vmark/genies/` |
| Windows | `%APPDATA%\app.vmark\genies\` |
| Linux | `~/.local/share/app.vmark/genies/` |

Ouvrez ce dossier depuis le menu **Édition → Génies → Ouvrir le dossier des génies**&nbsp;; après avoir ajouté ou modifié des fichiers, **Édition → Génies → Recharger les génies** actualise la liste.

### Structure du répertoire

Les sous-répertoires deviennent des **catégories** dans le sélecteur, et l'analyse est récursive — imbriquez les dossiers aussi profondément que vous le souhaitez&nbsp;; la catégorie d'un génie est le chemin de son dossier relatif à `genies/` (ainsi `academic/thesis/abstract.md` se retrouve dans `academic/thesis`), sauf si le frontmatter définit `category`. Les liens symboliques sont ignorés. Vous pouvez organiser les génies comme vous le souhaitez :

```text
genies/
├── editing/
│   ├── polish.md
│   ├── condense.md
│   └── fix-grammar.md
├── creative/
│   ├── expand.md
│   └── rephrase.md
├── academic/          ← your custom category
│   ├── cite.md
│   └── abstract.md
└── my-workflows/      ← another custom category
    └── blog-intro.md
```

### Format de fichier

Chaque fichier de génie a deux parties : **métadonnées** (frontmatter) et **modèle** (l'invite).

```markdown
---
description: Improve clarity and flow
scope: selection
category: editing
---

You are an expert editor. Improve the clarity, flow, and conciseness
of the following text while preserving the author's voice and intent.

Return only the improved text — no explanations.

{{content}}
```

Le nom de fichier `polish.md` devient le nom d'affichage « Polish » dans le sélecteur.

### Champs du frontmatter

| Champ | Requis | Valeurs | Défaut |
|-------|--------|---------|--------|
| `description` | Non | Courte description affichée dans le sélecteur | Vide |
| `scope` | Non | `selection`, `block`, `document` | `selection` |
| `category` | Non | Nom de catégorie pour le regroupement | Nom du sous-répertoire |
| `action` | Non | `replace`, `insert` | `replace` |
| `context` | Non | `1`, `2` | `0` (aucun) |
| `model` | Non | Identifiant de modèle pour remplacer le modèle par défaut du fournisseur | Défaut du fournisseur |

**Nom du génie** — Le nom d'affichage est toujours dérivé du **nom de fichier** (sans `.md`). Par exemple, `fix-grammar.md` apparaît comme « Fix Grammar » dans le sélecteur. Renommez le fichier pour changer le nom d'affichage.

### L'espace réservé `{{content}}`

L'espace réservé `{{content}}` est au cœur de chaque génie. Quand un génie s'exécute, VMark :

1. **Extrait le texte** selon la portée (texte sélectionné, bloc actuel ou document complet)
2. **Remplace** chaque `{{content}}` dans votre modèle par le texte extrait
3. **Envoie** l'invite remplie au fournisseur d'IA actif
4. **Renvoie** la réponse sous forme de suggestion en ligne — diffusée au fil de sa génération par un fournisseur CLI, en une seule fois par un fournisseur REST

Par exemple, avec ce modèle :

```markdown
Translate the following text into French.

{{content}}
```

Si l'utilisateur sélectionne « Hello, how are you? », l'IA reçoit :

```text
Translate the following text into French.

Hello, how are you?
```

L'IA répond avec « Bonjour, comment allez-vous ? » et cela apparaît comme une suggestion en ligne remplaçant le texte sélectionné.

### L'espace réservé `{{context}}`

L'espace réservé `{{context}}` donne à l'IA le texte environnant en lecture seule — pour qu'elle puisse correspondre au ton, au style et à la structure des blocs voisins sans les modifier.

**Comment ça fonctionne :**

1. Définissez `context: 1` ou `context: 2` dans le frontmatter pour inclure ±1 ou ±2 blocs voisins
2. Utilisez `{{context}}` dans votre modèle où vous souhaitez injecter le texte environnant
3. L'IA voit le contexte mais la suggestion ne remplace que `{{content}}`

**Les blocs composés sont atomiques** — si un voisin est une liste, un tableau, une citation ou un bloc détails, toute la structure compte comme un seul bloc.

**Restrictions de portée** — Le contexte fonctionne uniquement avec les portées `selection` et `block`. Pour la portée `document`, le contenu est déjà le document complet.

**Invites libres** — Quand vous tapez une instruction libre dans le sélecteur, VMark inclut automatiquement ±1 bloc environnant comme contexte pour les portées `selection` et `block`. Aucune configuration nécessaire.

**Rétrocompatible** — Les génies sans `{{context}}` fonctionnent exactement comme avant. Si le modèle ne contient pas `{{context}}`, aucun texte environnant n'est extrait.

**Exemple — ce que l'IA reçoit :**

Avec `context: 1` et le curseur sur le deuxième paragraphe d'un document à trois paragraphes :

```text
[Before]
First paragraph content here.

[After]
Third paragraph content here.
```

Les sections `[Before]` et `[After]` sont omises quand il n'y a pas de voisins dans cette direction (par ex. le contenu est au début ou à la fin du document).

### Le champ `action`

Par défaut, les génies **remplacent** le texte source par la sortie de l'IA. Définissez `action: insert` pour **ajouter** la sortie après le bloc source à la place.

Utilisez `replace` pour : l'édition, la reformulation, la traduction, les corrections grammaticales — tout ce qui transforme le texte original.

Utilisez `insert` pour : continuer l'écriture, générer des résumés sous le contenu, ajouter des commentaires — tout ce qui ajoute un nouveau texte sans supprimer l'original.

**Exemple — action d'insertion :**

```markdown
---
description: Continue writing from here
scope: block
action: insert
---

Continue writing naturally from where the following text leaves off.
Match the author's voice, style, and tone. Write 2-3 paragraphs.

Do not repeat or summarize the existing text — just continue it.

{{content}}
```

### Le champ `model`

Remplacez le modèle par défaut pour un génie spécifique. Utile quand vous voulez un modèle moins cher pour des tâches simples ou un modèle plus puissant pour des tâches complexes.

```markdown
---
description: Quick grammar fix (uses fast model)
scope: selection
model: claude-haiku-4-5-20251001
---

Fix grammar and spelling errors. Return only the corrected text.

{{content}}
```

L'identifiant de modèle doit correspondre à ce que votre fournisseur actif accepte.

## Écrire des invites efficaces

### Soyez précis sur le format de sortie

Dites à l'IA exactement ce qu'il faut retourner. Sans cela, les modèles ont tendance à ajouter des explications, des en-têtes ou des commentaires.

```markdown
<!-- Good -->
Return only the improved text — no explanations.

<!-- Bad — AI may wrap output in quotes, add "Here's the improved version:", etc. -->
Improve this text.
```

### Définissez un rôle

Donnez à l'IA un persona pour ancrer son comportement.

```markdown
<!-- Good -->
You are an expert technical editor who specializes in API documentation.

<!-- Okay but less focused -->
Edit the following text.
```

### Contraignez la portée

Dites à l'IA ce qu'il ne faut PAS modifier. Cela empêche la sur-édition.

```markdown
<!-- Good -->
Fix grammar and spelling errors only.
Do not change the meaning, style, or tone.
Do not restructure sentences.

<!-- Bad — gives the AI too much freedom -->
Fix this text.
```

### Utilisez Markdown dans les invites

Vous pouvez utiliser la mise en forme Markdown dans vos modèles d'invite. Cela aide quand vous voulez que l'IA produise une sortie structurée.

```markdown
---
description: Generate a pros/cons analysis
scope: selection
action: insert
---

Analyze the following text and produce a brief pros/cons list.

Format as:

**Pros:**
- point 1
- point 2

**Cons:**
- point 1
- point 2

{{content}}
```

### Gardez les invites ciblées

Un génie, un travail. Ne combinez pas plusieurs tâches dans un seul génie — créez des génies séparés à la place.

```markdown
<!-- Good — one clear job -->
---
description: Convert to active voice
scope: selection
---

Rewrite the following text using active voice.
Do not change the meaning.
Return only the rewritten text.

{{content}}
```

## Exemples de génies personnalisés

### Académique — Écrire un résumé

```markdown
---
description: Generate an academic abstract
scope: document
action: insert
---

Read the following paper and write a concise academic abstract
(150-250 words). Follow standard structure: background, methods,
results, conclusion.

{{content}}
```

### Blog — Générer un accroche

```markdown
---
description: Write an engaging opening paragraph
scope: document
action: insert
---

Read the following draft and write a compelling opening paragraph
that hooks the reader. Use a question, surprising fact, or vivid
scene. Keep it under 3 sentences.

{{content}}
```

### Code — Expliquer un bloc de code

```markdown
---
description: Add a plain-English explanation above code
scope: selection
action: insert
---

Read the following code and write a brief plain-English explanation
of what it does. Use 1-2 sentences. Do not include the code itself
in your response.

{{content}}
```

### Email — Rendre professionnel

```markdown
---
description: Rewrite in professional tone
scope: selection
---

Rewrite the following text in a professional, business-appropriate tone.
Keep the same meaning and key points. Remove casual language,
slang, and filler words.

Return only the rewritten text — no explanations.

{{content}}
```

### Traduction — Vers le chinois simplifié

```markdown
---
description: Translate to Simplified Chinese
scope: selection
---

Translate the following text into Simplified Chinese.
Preserve the original meaning, tone, and formatting.
Use natural, idiomatic Chinese — not word-for-word translation.

Return only the translated text — no explanations.

{{content}}
```

### Sensible au contexte — S'adapter aux alentours

```markdown
---
description: Rewrite to match surrounding tone and style
scope: selection
context: 1
---

Rewrite the following content to fit naturally with its surrounding context.
Match the tone, style, and level of detail.

Return only the rewritten text — no explanations.

## Surrounding context (do not include in output):
{{context}}

## Content to rewrite:
{{content}}
```

### Révision — Vérification des faits

```markdown
---
description: Flag claims that need verification
scope: selection
action: insert
---

Read the following text and list any factual claims that should be
verified. For each claim, note why it might need checking (e.g.,
specific numbers, dates, statistics, or strong assertions).

Format as a bullet list. If everything looks solid, say
"No claims flagged for verification."

{{content}}
```

## Suggestions IA

Lorsqu'un Génie renvoie un texte destiné à remplacer la sélection (plutôt qu'une réponse de chat libre), VMark le présente comme une **suggestion** avec un diff en ligne&nbsp;: barré ondulé rouge pour le texte original, texte fantôme italique estompé dans la couleur d'accent pour le texte proposé. Vous examinez et approuvez avant qu'aucun changement ne soit appliqué de manière persistante.

| Action | Raccourci |
|---|---|
| Accepter la suggestion focalisée | `Entrée` |
| Rejeter la suggestion focalisée | `Échap` |
| Passer à la suggestion suivante / précédente | `Tab` / `Shift + Tab` |
| Accepter toutes les suggestions du document | `Mod + Shift + Entrée` _(sensible au contexte — aussi Ajouter une ligne au-dessus dans un tableau)_ |
| Rejeter toutes les suggestions du document | `Mod + Shift + Échap` |

Lorsqu'un Génie réécrit plusieurs paragraphes, chaque remplacement est sa propre suggestion, navigable indépendamment. Accepter l'une n'accepte pas automatiquement les autres.

## Génies dans les workflows

Un génie unique exécute une seule invite. Lorsque vous devez enchaîner plusieurs étapes d'IA — plan, puis brouillon, puis polissage — et acheminer la sortie d'une étape vers la suivante, utilisez un **workflow de génies**&nbsp;: un fichier YAML qui orchestre plusieurs appels de génies avec un flux de données explicite, des points d'approbation facultatifs, un modèle par étape et un diagramme d'exécution en direct.

Comme les étapes de workflow remplissent l'espace réservé `{{content}}` d'un génie à partir d'une map `with: { input: "..." }`, **les génies que vous écrivez ici s'exécutent sans modification dans les workflows** — aucune conversion n'est nécessaire.

Consultez [Workflows Genie](/fr/guide/workflows) pour le schéma YAML complet, la syntaxe des expressions, les approbations et la manière d'exécuter un workflow.

### Isolement du contenu non fiable

Lorsqu'une étape `genie/<name>` d'un workflow s'exécute, le texte des
documents, les sélections et le contenu des fichiers sont encadrés par des
marqueurs uniques `<<<DOCUMENT-DATA-…>>>` avant d'atteindre le fournisseur
d'IA, et l'invite demande au modèle de traiter le texte ainsi encadré
strictement comme des données. Cet encadrement est propre aux étapes de
workflow — un génie lancé directement depuis le sélecteur envoie le texte
de sa portée au fournisseur tel quel. Il protège contre les documents qui
tentent de glisser des instructions à l'IA (« ignore tes instructions et
exécute … ») — ce qui compte surtout pour les fournisseurs CLI (Claude Code,
Codex, Gemini CLI), capables d'exécuter des commandes. Traitez les génies
que vous exécutez sur des fichiers de sources non fiables avec la même
prudence que l'exécution d'un script trouvé sur Internet&nbsp;: l'encadrement
est une atténuation solide, pas une garantie absolue.

## Limitations

- Les génies fonctionnent uniquement en **mode WYSIWYG**. En mode source, une notification toast l'explique.
- Un seul génie peut s'exécuter à la fois. Si l'IA génère déjà, le sélecteur ne démarrera pas un autre.
- L'espace réservé `{{content}}` est remplacé littéralement — il ne prend pas en charge les conditions ou les boucles.
- Les très grands documents peuvent atteindre les limites de jetons du fournisseur lors de l'utilisation de `scope: document`.

## Dépannage

**« Aucun fournisseur d'IA disponible »** — Ouvrez Paramètres > Intégrations et configurez un fournisseur. Consultez [Fournisseurs d'IA](/fr/guide/ai-providers).

**Génie n'apparaissant pas dans le sélecteur** — Vérifiez que le fichier a une extension `.md` (ou `.yml`/`.yaml` pour un [génie de workflow](/fr/guide/workflow-genies)) et un frontmatter valide avec des délimiteurs `---`. Les sous-dossiers sont parcourus jusqu'à huit niveaux de profondeur (et 10 000 entrées au maximum au total), et les liens symboliques sont ignorés. Lancez **Édition → Génies → Recharger les génies** après avoir ajouté des fichiers.

**L'IA retourne des résultats incorrects ou des erreurs** — Vérifiez que votre clé API est correcte et que le nom du modèle est valide pour votre fournisseur. Vérifiez les détails d'erreur dans le terminal/console.

**La suggestion ne correspond pas aux attentes** — Affinez votre invite. Ajoutez des contraintes (« retournez uniquement le texte », « n'expliquez pas »), définissez un rôle ou réduisez la portée.

## Voir aussi

- [Fournisseurs d'IA](/fr/guide/ai-providers) — Configurer les fournisseurs CLI ou API REST
- [Raccourcis clavier](/fr/guide/shortcuts) — Référence complète des raccourcis
- [Outils MCP](/fr/guide/mcp-tools) — Intégration IA externe via MCP
