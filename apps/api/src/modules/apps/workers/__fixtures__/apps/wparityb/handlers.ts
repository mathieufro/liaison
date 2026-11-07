// SPDX-License-Identifier: FSL-1.1-ALv2
// Workers parity fixture B: the target of wparity's nested hop.

export async function echo(p: { v: string }) {
  return { echo: p.v, from: "wparityb" }
}
