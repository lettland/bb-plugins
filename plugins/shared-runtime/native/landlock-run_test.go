//go:build linux

package main

import (
	"fmt"
	"syscall"
	"testing"
)

// Regression tests for the launcher's metadata seccomp filter.
//
// Learned in BB thread thr_69ubadfky5: seccomp sees the per-ABI syscall number; without the arch
// check, i386, x32 and AArch32 calls bypassed the metadata guard. The filter only compared
// seccomp_data.nr with the native table, so an i386 chmod (nr 15 on i386) or an x32 chmod
// (nr 90 | 0x40000000 on amd64) was never matched and ran with the filter's ALLOW verdict.
// The filter now checks seccomp_data.arch first and kills foreign ABIs.

const (
	auditArchI386 = 0x40000003
	auditArchARM  = 0x40000028

	verdictAllow = seccompReturnAllow
	verdictEPERM = seccompReturnErrno | uint32(syscall.EPERM)
	verdictKill  = seccompReturnKillProcess
)

// runFilter evaluates a classic BPF program over a seccomp_data of {nr, arch}. It supports only
// the instructions metadataFilter emits and fails on anything else, so a new opcode in the
// filter shows up here as a test failure instead of a silent mis-evaluation.
func runFilter(program []socketFilter, nr uint32, arch uint32) (uint32, error) {
	var accumulator uint32
	for pc, steps := 0, 0; steps < 4096; steps++ {
		if pc < 0 || pc >= len(program) {
			return 0, fmt.Errorf("program counter %d left the program of %d instructions", pc, len(program))
		}
		instruction := program[pc]
		switch instruction.Code {
		case bpfLoadWordAbsolute:
			switch instruction.K {
			case 0:
				accumulator = nr
			case 4:
				accumulator = arch
			default:
				return 0, fmt.Errorf("instruction %d loads seccomp_data offset %d", pc, instruction.K)
			}
			pc++
		case bpfJumpEqualConstant:
			if accumulator == instruction.K {
				pc += 1 + int(instruction.JT)
			} else {
				pc += 1 + int(instruction.JF)
			}
		case bpfJumpGreaterEqualConstant:
			if accumulator >= instruction.K {
				pc += 1 + int(instruction.JT)
			} else {
				pc += 1 + int(instruction.JF)
			}
		case bpfReturnConstant:
			return instruction.K, nil
		default:
			return 0, fmt.Errorf("instruction %d has unsupported opcode %#x", pc, instruction.Code)
		}
	}
	return 0, fmt.Errorf("program did not return")
}

func nativeArch(goarch string) uint32 {
	if goarch == "amd64" {
		return auditArchX8664
	}
	return auditArchAarch64
}

func otherNativeArch(goarch string) uint32 {
	if goarch == "amd64" {
		return auditArchAarch64
	}
	return auditArchX8664
}

func expectVerdict(t *testing.T, program []socketFilter, nr uint32, arch uint32, want uint32, label string) {
	t.Helper()
	got, err := runFilter(program, nr, arch)
	if err != nil {
		t.Fatalf("%s: nr=%d arch=%#x: %v", label, nr, arch, err)
	}
	if got != want {
		t.Errorf("%s: nr=%d arch=%#x: verdict %#x, want %#x", label, nr, arch, got, want)
	}
}

func TestMetadataFilterForeignABIsAreKilled(t *testing.T) {
	for _, goarch := range []string{"amd64", "arm64"} {
		program, err := metadataFilter(goarch)
		if err != nil {
			t.Fatalf("%s: %v", goarch, err)
		}
		foreign := map[string]uint32{
			"i386":         auditArchI386,
			"ARM":          auditArchARM,
			"other-arch":   otherNativeArch(goarch),
			"unknown-arch": 0,
		}
		// i386 chmod is 15 and i386 exit is 1; neither is in a native metadata table, which is
		// exactly why the number alone cannot decide. Every one must die, metadata or not.
		for name, arch := range foreign {
			for _, nr := range []uint32{0, 1, 15, 63, 90, 94, 452} {
				expectVerdict(t, program, nr, arch, verdictKill, goarch+" foreign "+name)
			}
			for _, nr := range mustSyscalls(t, goarch) {
				expectVerdict(t, program, nr, arch, verdictKill, goarch+" foreign "+name+" metadata")
			}
		}
	}
}

func TestMetadataFilterKillsX32OnAmd64Only(t *testing.T) {
	amd64, err := metadataFilter("amd64")
	if err != nil {
		t.Fatal(err)
	}
	for _, nr := range []uint32{0, 1, 60, 90, 231, 452} {
		expectVerdict(t, amd64, nr|x32SyscallBit, auditArchX8664, verdictKill, "amd64 x32")
	}
	expectVerdict(t, amd64, x32SyscallBit, auditArchX8664, verdictKill, "amd64 x32 lowest")
	// Regression: the x32 check also caught syscall(-1), which tools use to probe and which must
	// keep returning ENOSYS from the kernel. libseccomp allows it for the same reason.
	expectVerdict(t, amd64, 0xFFFFFFFF, auditArchX8664, verdictAllow, "amd64 syscall(-1)")
	expectVerdict(t, amd64, 0xFFFFFFFE, auditArchX8664, verdictKill, "amd64 just below syscall(-1)")
	expectVerdict(t, amd64, x32SyscallBit|90, auditArchX8664, verdictKill, "amd64 x32 chmod")
	// A foreign ABI is killed even for the number that is allowed natively.
	expectVerdict(t, amd64, 0xFFFFFFFF, auditArchI386, verdictKill, "i386 syscall(-1)")
	expectVerdict(t, amd64, x32SyscallBit-1, auditArchX8664, verdictAllow, "amd64 just below the x32 bit")

	// The check is amd64-only: arm64 has no x32 ABI, so a high number is an ordinary unknown
	// syscall for the kernel to reject, not something the filter kills.
	arm64, err := metadataFilter("arm64")
	if err != nil {
		t.Fatal(err)
	}
	expectVerdict(t, arm64, 63|x32SyscallBit, auditArchAarch64, verdictAllow, "arm64 high number")
	expectVerdict(t, arm64, 0xFFFFFFFF, auditArchAarch64, verdictAllow, "arm64 syscall(-1)")
}

func mustSyscalls(t *testing.T, goarch string) []uint32 {
	t.Helper()
	syscalls, err := metadataMutationSyscalls(goarch)
	if err != nil {
		t.Fatal(err)
	}
	return syscalls
}

func TestMetadataFilterNativeMetadataGetsEPERM(t *testing.T) {
	for _, goarch := range []string{"amd64", "arm64"} {
		program, err := metadataFilter(goarch)
		if err != nil {
			t.Fatalf("%s: %v", goarch, err)
		}
		for _, nr := range mustSyscalls(t, goarch) {
			expectVerdict(t, program, nr, nativeArch(goarch), verdictEPERM, goarch+" native metadata")
		}
	}
}

// The list is spelled out here as well, so deleting an entry from the source cannot also delete
// it from the expectation. 452 is fchmodat2; 463, 466 and 469 are setxattrat, removexattrat and
// file_setattr, which are numbered the same on both architectures.
func TestMetadataFilterPinnedNumbers(t *testing.T) {
	pinned := map[string][]uint32{
		"amd64": {
			90, 91, 92, 93, 94, 132,
			188, 189, 190, 197, 198, 199,
			235, 260, 261, 268, 280, 452, 463, 466, 469,
		},
		"arm64": {
			5, 6, 7, 14, 15, 16,
			52, 53, 54, 55, 88, 452, 463, 466, 469,
		},
	}
	for goarch, numbers := range pinned {
		program, err := metadataFilter(goarch)
		if err != nil {
			t.Fatalf("%s: %v", goarch, err)
		}
		for _, nr := range numbers {
			expectVerdict(t, program, nr, nativeArch(goarch), verdictEPERM, goarch+" pinned")
		}
	}
}

func TestMetadataFilterOrdinaryNativeCallsAreAllowed(t *testing.T) {
	// read, write and exit_group on each architecture, plus numbers next to listed ones.
	ordinary := map[string][]uint32{
		"amd64": {0, 1, 3, 59, 89, 95, 231, 262, 451, 453, 462, 464, 467, 470},
		"arm64": {63, 64, 94, 93, 4, 8, 451, 453, 462, 464, 467, 470},
	}
	for goarch, numbers := range ordinary {
		program, err := metadataFilter(goarch)
		if err != nil {
			t.Fatalf("%s: %v", goarch, err)
		}
		for _, nr := range numbers {
			expectVerdict(t, program, nr, nativeArch(goarch), verdictAllow, goarch+" ordinary")
		}
	}
}

func TestMetadataFilterRejectsUnknownGoarch(t *testing.T) {
	for _, goarch := range []string{"", "386", "arm", "riscv64", "s390x"} {
		program, err := metadataFilter(goarch)
		if err == nil {
			t.Errorf("goarch %q: want an error, got a program of %d instructions", goarch, len(program))
		}
	}
}
