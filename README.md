# La Popote — borne autonome pour iPad

Tout s'exécute dans l'iPad : l'application, les cartes, les ardoises, les boissons, le journal et les
comptes responsables. Aucun serveur, aucune base de données externe, aucun réseau nécessaire une fois
installée.

## Ce que fait la borne

**Deux sections indépendantes** (ex. Section 1 et Section 2) partagent la tablette. L'accueil propose le choix de
la section ; chacune a son propre code responsable, ses produits, tarifs, stocks, clients, journal, horaires et
sauvegarde. Les données existantes avant la version 3.0.0 deviennent la Section 1. Le nom de chaque section se
change dans *Réglages*. Après une commande, ou en cas d'inactivité, la borne revient toujours à l'écran des tarifs de la
section en cours ; le bouton « Changer de section » ramène au choix des sections.

**Ouverture des commandes** (par section, dans *Réglages*) : **Ouvert** ou **Fermé** au choix du responsable,
ou **Horaires** (ex. 18:00 à 21:30, une plage après minuit est acceptée), ou **Un jour sur deux** : deux horaires
A et B qui alternent chaque jour (A, B, A, B… sans tenir compte des semaines), chacun pouvant être « fermé » ;
on indique simplement si aujourd'hui est un jour A ou B. Fermé : le bouton Commander
affiche « Fermé » ; on peut toujours consulter les tarifs et créer une carte. Par défaut : Ouvert.

Les identifiants des clients sont saisis, affichés et enregistrés en MAJUSCULES
(la connexion ne tient compte ni des majuscules ni des accents).

- **Créer ma carte** : nom + code à 6 chiffres saisi deux fois (les codes trop simples sont refusés).
  La carte est alors **en attente** : aucune commande possible tant qu'un responsable ne l'a pas validée.
- **Commander** : nom + code, choix du produit et de la quantité → déduit du solde de la carte, stock décompté.
  Impossible de commander au-delà de ce qu'il reste sur la carte (la quantité est limitée automatiquement,
  les produits trop chers sont grisés). Un découvert peut être autorisé dans *Réglages*.
- 5 codes faux → carte bloquée 10 min. Retour automatique à l'accueil après inactivité.

## Gestion par les responsables (sur la tablette)

Bouton **Responsable** en bas à droite de l'accueil (ou appui long de 3 s sur le titre) → code responsable à 8 chiffres au pavé numérique (sans identifiant ni clavier).
Un seul responsable par section : le code est partagé par les personnes qui gèrent la section ;
5 codes faux bloquent la gestion 10 minutes.

- *Ardoises* : les cartes **à valider** apparaissent en tête de liste et dans le résumé.
  Dans la fiche : **Valider la carte**, ou **Refuser et supprimer** (le nom redevient libre).
  **Supprimer la carte** (bas de la fiche) : la carte disparaît, le nom redevient libre, l'historique reste
  au journal ; une ardoise non réglée est signalée avant suppression puis notée comme effacée.
  Pour une carte validée : paiement reçu (« Tout régler »), correction avec motif, nouveau code, déblocage, désactivation.
- *Produits* : classés en trois catégories — **Bières**, **Softs** (sans alcool) et **Divers** (chips,
  cacahuètes, saucisson, barres chocolatées…). Ajout avec sa catégorie, changement de catégorie, prix, emoji,
  réassort, inventaire, retirer/remettre sur la borne. Sur la borne : rubriques sur l'accueil, onglets au moment
  de commander. Les produits créés avant cette version sont classés automatiquement d'après leur nom : vérifiez-les.
- *Journal* : toutes les opérations, annulation d'une commande ou d'un paiement (ardoise et stock corrigés),
  export CSV pour Excel.
- *Réglages → Code responsable* : changer le code de la section (au pavé numérique).
- *Réglages* : découvert autorisé (0 € par défaut), sauvegarde et restauration, version de l'application,
  et **Remise à zéro** : *Réinitialiser* (efface cartes, soldes et journal ; garde produits, stocks,
  responsables, réglages) ou *Tout effacer* (retour à la première mise en route). Chaque action demande
  de taper un mot de confirmation.
- Images des produits : choisies dans une grille (bouton à gauche du nom), ou automatiques d'après le nom.
- La gestion se referme seule après 5 minutes sans action, et avec « Revenir à la borne ».

Quand on entre pour la première fois dans une section, la borne demande de choisir son code responsable.

## Installer sur l'iPad

Safari ne sait pas lancer une application web depuis un fichier local : il faut l'ouvrir **une fois** depuis
une adresse HTTPS. Ensuite, l'iPad en garde une copie complète et n'a plus besoin du réseau.

Le plus simple, gratuit, avec GitHub Pages :

1. Créer un dépôt (public ou privé selon ton offre), y déposer **tout le contenu de ce dossier** à la racine.
2. *Settings → Pages → Deploy from a branch → main / (root)*. L'adresse ressemble à
   `https://<compte>.github.io/<depot>/`.
3. Sur l'iPad, ouvrir cette adresse dans **Safari**, puis **Partager → Sur l'écran d'accueil**.
4. Lancer **Popote depuis l'icône** (plein écran, et les données sont protégées contre l'effacement
   automatique de Safari). Choisir la section, son code responsable, puis ajouter les produits.

N'importe quel hébergement de fichiers statiques en HTTPS convient (Netlify, Cloudflare Pages…).

**Important :**
- Les données sont liées à l'adresse d'installation. Si l'adresse change, la borne repart vide :
  faire une sauvegarde avant, puis la restaurer sur la nouvelle installation.
- Laisser l'hébergement en place : la borne ne s'en sert pas pour fonctionner, mais il permet de publier
  des mises à jour (et un iPad réinitialisé pourra se réinstaller).
- Ne pas utiliser « Effacer historique et données de sites » dans Safari, ni supprimer l'icône :
  cela efface les données. D'où l'importance des sauvegardes.

### Mode borne (Accès guidé)

- Réglages → Luminosité et affichage → **Verrouillage automatique : Jamais**, iPad sur secteur.
- Réglages → Accessibilité → **Accès guidé** : activer, définir un code. Ouvrir Popote,
  **triple-clic** sur le bouton latéral → Démarrer.

## Sauvegardes

Les données n'existent que dans cet iPad. **Chaque section se sauvegarde séparément** : dans la gestion de la
section, *Réglages → Créer une sauvegarde* ouvre la
feuille de partage : enregistrer dans Fichiers / iCloud Drive, AirDrop, ou s'envoyer par e-mail.
Le nom du fichier est proposé (popote-<section>-<date>) et peut être changé avant d'enregistrer.
Une alerte apparaît dans la gestion si la dernière sauvegarde date de plus de 7 jours.

Pour changer d'iPad : installer la borne sur le nouvel iPad, créer un compte provisoire,
puis *Sauvegarde → Restaurer*. Le code responsable de la sauvegarde remplace le code provisoire.

## Mettre à jour l'application

La version suit le format **x.y.z** (affichée en bas à gauche de l'accueil et dans *Réglages*) :
`x.y.Z` correction, `x.Y.0` nouvelle fonction, `X.0.0` changement majeur.

Modifier les fichiers, augmenter `VERSION` en haut de `sw.js` (ex. `1.5.0` → `1.5.1`), publier. L'iPad doit
être connecté au moment du lancement pour récupérer la nouvelle version ; elle s'applique au lancement suivant.
Les données ne sont pas touchées.

## Sécurité, en bref

- Codes et mots de passe jamais stockés en clair (PBKDF2-SHA-256, 150 000 itérations, sel individuel).
- Chaque modification (ardoise + stock + journal) est écrite d'un seul bloc : rien n'est jamais à moitié
  enregistré, même si l'iPad s'éteint pendant une commande.
- Aucune ressource externe (polices intégrées, licence OFL dans `fonts/`).
- Un code à 6 chiffres reste un secret simple : il protège l'ardoise des curieux. Le journal et
  l'annulation permettent de corriger toute erreur ou abus.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | écrans de la borne et de la gestion |
| `store.js` | données locales (IndexedDB), règles métier, sauvegarde |
| `kiosk.js` | borne : identification, création de carte, commande, accès responsable |
| `admin.js` | gestion : ardoises, produits, journal, réglages, sauvegarde |
| `boot.js`, `sw.js` | démarrage et fonctionnement hors ligne |
| `theme.css`, `common.css`, `fonts/`, icônes, `manifest.webmanifest` | thème sombre, polices embarquées, installation sur l'écran d'accueil |

Pour essayer sur un ordinateur : `python3 -m http.server 8088` dans ce dossier, puis `http://localhost:8088`.
