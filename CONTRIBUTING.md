# Contributing to Brain

Thanks for helping improve Brain. This guide covers how to set up the project, make a change, and send it for review. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting set up

You need Node.js 22+, npm, and Git.

```bash
git clone https://github.com/Google-Developers-Group-IIT-MANDI/Brain.git
cd Brain
npm install
npm run build
```

Useful scripts:

- `npm run dev` runs the CLI from source with `tsx`.
- `npm run build` compiles TypeScript to `dist/`.
- `npm test` runs `test-runner.ts`.

To try your build against another project, run `npm link` in the checkout, then `brain init` and `brain watch` inside that project.

## Hacktoberfest 26 at GDG IIT Mandi

Brain is one of the official repositories for Hacktoberfest 26, hosted by Google Developer Groups, IIT Mandi (Oct 1 to Oct 31, 2026). The event rewards genuine work, so quality counts more than the number of pull requests.

Ground rules:

1. Register on the event page and link your GitHub account. Only registered participants are counted.
2. Only pull requests opened between Oct 1 and Oct 31, 2026 against the official repository count.
3. Claim before you code. Comment on an issue and wait for a maintainer to assign it. One issue, one pull request.
4. Keep it genuine. Spam, empty commits, whitespace-only edits, duplicate pull requests, and bot-farmed PRs are not accepted.
5. Make it your own work. If you use AI tools, you must understand and be able to explain every line you submit.
6. Follow this guide and the [Code of Conduct](CODE_OF_CONDUCT.md), and be kind in every review and comment.
7. Maintainers have the final say. A pull request marked spam or invalid does not count. The sequence is a warning, then marked invalid, then disqualification for repeated spam.

Issue labels:

- `good first issue`: start here.
- `help wanted`: medium effort.
- `hard`: bigger features.
- `docs`: no code needed.

Stuck? Ask in the issue thread, tag a maintainer on your pull request, or use the GDG IIT Mandi community chat and the weekend help sessions.

## Your first contribution

New to open source? Here is the full path from issue to merged pull request.

1. Pick an issue labelled `good first issue`. Comment on it to say you want to work on it, and wait for a maintainer to assign it to you before you start. This stops two people fixing the same bug.
2. Click **Fork** at the top right of the repository page, then clone your fork:

   ```bash
   git clone https://github.com/<your-username>/Brain.git
   cd Brain
   git remote add upstream https://github.com/Google-Developers-Group-IIT-MANDI/Brain.git
   ```

3. Create a branch for the issue: `git checkout -b fix/short-description`.
4. Make the change, then run `npm run build` and `npm test`.
5. Commit with a short message that says what changed, for example `Fix crash when .brain/config.json is missing`, then push: `git push origin fix/short-description`.
6. Open a pull request from your fork to `main`. Fill in the template and write `Fixes #<issue number>` so the issue closes when the PR merges.
7. Reviewers will leave comments. This is normal and not a rejection. Push more commits to the same branch to address them and the pull request updates itself.

Small pull requests are welcome, and asking questions on the issue is encouraged. If you get stuck, say where in the issue thread.

## Reporting bugs and requesting features

Open an issue before starting large work. For a bug, include:

- What you ran and what you expected.
- What happened instead, with the exact error text.
- Your Node.js version, OS, and the output of `brain status` if it applies.

Do not paste API keys or the contents of your `.env` file.

## Making a change

1. Fork the repository and create a branch from `main`, for example `fix/watch-port` or `feat/rust-parser`.
2. Keep each pull request focused on one change.
3. Match the style of the surrounding code. The project is TypeScript with ES modules.
4. Run `npm run build` and `npm test` before you push. Both must pass.
5. Add or update a test when you change behavior.
6. Update `README.md` when you change a command, option, or default.

Never commit `.env` or the `.brain/` directory. Both are ignored by Git and must stay that way.

## Pull requests

Open the pull request against `main`. In the description, lead with the problem and the resulting behavior, then say how you tested it and note anything risky. Write it for a reviewer who has not seen your discussion elsewhere. Link the related issue if there is one.

A maintainer will review it, may ask for changes, and will merge it once the checks pass.

## License

By contributing you agree that your contributions are licensed under the MIT License that covers this project.
