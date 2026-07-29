# Signed commits

Git commits are normally attributed through the author identity configured
on the commit, usually an email address. That identity is useful evidence,
but an email address alone can be claimed or impersonated.

Signed commits add a cryptographic signature to the commit. This allows
verifiers to attribute work through possession of a signing key rather than
only a claimable email address.

Unsigned commits remain valid evidence. Signing does not replace existing
credential evidence; it strengthens attribution by adding cryptographic
proof of authorship.

To enable SSH commit signing:

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
```

GitHub displays commits as **Verified** after you upload your public SSH
key as a signing key to your GitHub account.
