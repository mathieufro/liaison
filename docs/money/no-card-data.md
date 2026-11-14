---
title: What Liaison holds about cards
description: "Liaison holds no card numbers. What it keeps, what it hides, and what stays between you and Stripe."
---

Liaison does not take, store or send card numbers, and it has no tool that charges a card.

## What it keeps

For a card: its brand, its last 4 digits and its expiry. Nothing else. No column of the Stripe mirror can hold a card number or a security code. Raw event bodies and Stripe `metadata` are not stored.

## What it hides

A card number written in a customer's name or description, an invoice memo or line, a payment failure message or a dispute reason is hidden before anything is stored. The connection's admins get one item on Home saying so. A refund reason that holds a card number is refused.

## How people pay

Customers enter their card on Stripe's own pages. Liaison only links to those pages: a hosted invoice or your customer portal. The key it uses is restricted, and is added to each request by the server, so the app's code never holds it.

## Your PCI status

Liaison does not change your PCI status. You still attest it with Stripe, as the merchant. Ask your Stripe account or your accountant what applies to you.
